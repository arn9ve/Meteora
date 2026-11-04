#!/usr/bin/env node

import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TARGET = '192.168.10.1';
const COMMAND_PORT = 8889;
const EXPECTED_MAC = '60:60:1f:62:a5:91';
const ALLOWED_COMMANDS = new Set(['command', 'battery?', 'sdk?']);

function safeCode(error) {
  return typeof error?.code === 'string' ? error.code : 'UDP_ERROR';
}

function closeSocket(socket) {
  try {
    socket.close();
  } catch {
    // A socket that failed before binding is already effectively closed.
  }
}

function bindSocket(socket, localAddress, localPort) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off('error', onError);
      resolve(socket.address());
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(localPort, localAddress);
  });
}

function request(socket, { host, commandPort, command, timeoutMs, validate }) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error('Command not allowlisted');
  }

  return new Promise((resolve) => {
    let settled = false;
    let receivedPackets = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      resolve({ ...result, receivedPackets });
    };
    const onError = (error) => finish({ status: 'error', code: safeCode(error) });
    const onMessage = (payload, peer) => {
      if (peer.address !== host || peer.port !== commandPort) return;
      receivedPackets += 1;
      const text = payload.toString('utf8').replaceAll('\0', '').trim();
      if (/^(error|unknown command)\b/i.test(text)) { finish({status:'rejected', code:'DRONE_REJECTED'}); return; }
      const value = validate(text);
      if (value === undefined) return;
      finish(value === true ? { status: 'ok' } : { status: 'ok', value });
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.send(command, commandPort, host, (error) => {
      if (error) finish({ status: 'error', code: safeCode(error) });
    });
  });
}

function validateBattery(text) {
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 0 && value <= 100 ? value : undefined;
}

function validateSdk(text) {
  return /^\d+(?:\.\d+)*$/.test(text) ? text : undefined;
}

export async function probe({
  host,
  commandPort,
  localAddress,
  localPort,
  timeoutMs = 2500,
}) {
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => {});
  const result = {
    binding: { address: localAddress, port: localPort },
    command: { status: 'not-run' },
    battery: { status: 'not-run' },
    sdk: { status: 'not-run' },
  };

  try {
    const address = await bindSocket(socket, localAddress, localPort);
    result.binding = { address: address.address, port: address.port };
    result.command = await request(socket, {
      host,
      commandPort,
      command: 'command',
      timeoutMs,
      validate: (text) => text.toLowerCase() === 'ok' ? true : undefined,
    });

    if (result.command.status !== 'ok') return result;

    result.battery = await request(socket, {
      host,
      commandPort,
      command: 'battery?',
      timeoutMs,
      validate: validateBattery,
    });
    result.sdk = await request(socket, {
      host,
      commandPort,
      command: 'sdk?',
      timeoutMs,
      validate: validateSdk,
    });
    return result;
  } catch (error) {
    result.command = { status: 'error', code: safeCode(error) };
    return result;
  } finally {
    closeSocket(socket);
  }
}

function en0TelloAddress() {
  return (networkInterfaces().en0 ?? []).find((entry) =>
    entry.family === 'IPv4' && /^192\.168\.10\.\d+$/.test(entry.address)
  )?.address;
}

function normalizeMac(value) {
  const parts = value.toLowerCase().split(':');
  if (parts.length !== 6 || parts.some((part) => !/^[0-9a-f]{1,2}$/.test(part))) return undefined;
  return parts.map((part) => part.padStart(2, '0')).join(':');
}

async function inspectCommand(file, args, timeout = 5000) {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout, maxBuffer: 256_000 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, code: safeCode(error), stdout: typeof error?.stdout === 'string' ? error.stdout : '' };
  }
}

async function inspectNetwork() {
  const [route, ping] = await Promise.all([
    inspectCommand('/sbin/route', ['-n', 'get', TARGET]),
    inspectCommand('/sbin/ping', ['-c', '2', '-W', '1000', TARGET]),
  ]);
  const arp = await inspectCommand('/usr/sbin/arp', ['-an']);
  const routeInterface = route.stdout.match(/^\s*interface:\s*(\S+)/m)?.[1];
  const routeGateway = route.stdout.match(/^\s*gateway:\s*(\S+)/m)?.[1];
  const arpLine = arp.stdout.split('\n').find((line) => line.includes(`(${TARGET})`));
  const arpMacText = arpLine?.match(/\bat\s+([0-9a-f:]+)/i)?.[1];
  const arpMac = arpMacText ? normalizeMac(arpMacText) : undefined;
  const received = Number(ping.stdout.match(/(\d+) packets received/)?.[1] ?? 0);

  return {
    route: { ok: route.ok, interface: routeInterface, gateway: routeGateway, error: route.ok ? undefined : route.code },
    ping: { ok: received > 0, received, error: ping.ok || received > 0 ? undefined : ping.code },
    arp: {
      ok: Boolean(arpMac),
      mac: arpMac,
      expectedMac: EXPECTED_MAC,
      matchesExpected: arpMac ? arpMac === EXPECTED_MAC : false,
      error: arp.ok ? undefined : arp.code,
    },
  };
}

function parseTelemetry(text) {
  const values = {};
  for (const key of ['bat', 'h', 'yaw']) {
    const match = text.match(new RegExp(`(?:^|;)${key}:(-?\\d+(?:\\.\\d+)?)(?:;|$)`));
    if (match) values[key] = Number(match[1]);
  }
  return values;
}

const START = Date.now();
const elapsed = () => Date.now() - START;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function printableText(payload) {
  const text = payload.toString('utf8').replaceAll('\0', '').trim();
  return /^[\x20-\x7e]{1,32}$/.test(text) ? text : undefined;
}

async function startTelemetry() {
  const socket = dgram.createSocket('udp4');
  const result = { status: 'listening', packets: 0, firstAtMs: null, sourcePorts: [], latest: {}, errors: [] };
  socket.on('message', (payload, peer) => {
    if (peer.address !== TARGET) return;
    const values = parseTelemetry(payload.toString('utf8'));
    if (!Object.keys(values).length) return;
    result.packets += 1;
    result.firstAtMs ??= elapsed();
    if (!result.sourcePorts.includes(peer.port)) result.sourcePorts.push(peer.port);
    result.latest = { ...result.latest, ...values };
  });
  socket.on('error', (error) => {
    result.status = 'error';
    const code = safeCode(error);
    if (!result.errors.includes(code)) result.errors.push(code);
  });
  try {
    await bindSocket(socket, '0.0.0.0', 8890);
  } catch (error) {
    result.status = 'error';
    result.errors.push(safeCode(error));
    closeSocket(socket);
  }
  return { socket, result };
}

// Opens every control socket at once and keeps all of them open for the whole run,
// so a reply that lands on a different local port than the sender is still recorded.
async function openSniffers(bindings) {
  const sniffers = [];
  for (const [localAddress, localPort] of bindings) {
    const socket = dgram.createSocket('udp4');
    const entry = { socket, requested: { address: localAddress, port: localPort }, bound: null, error: null, sentAtMs: null, sendError: null, otherSenders: 0 };
    socket.on('error', (error) => { entry.error ??= safeCode(error); });
    try {
      entry.bound = await bindSocket(socket, localAddress, localPort);
    } catch (error) {
      entry.error = safeCode(error);
      closeSocket(socket);
    }
    sniffers.push(entry);
  }
  return sniffers;
}

function recordReplies(sniffers, packets) {
  for (const entry of sniffers) {
    if (!entry.bound) continue;
    entry.socket.on('message', (payload, peer) => {
      if (peer.address !== TARGET) { entry.otherSenders += 1; return; }
      packets.push({ atMs: elapsed(), localPort: entry.bound.port, fromPort: peer.port, bytes: payload.length, text: printableText(payload) });
    });
  }
}

function sendCommand(entry) {
  return new Promise((resolve) => {
    entry.sentAtMs = elapsed();
    entry.socket.send('command', COMMAND_PORT, TARGET, (error) => {
      if (error) entry.sendError = safeCode(error);
      resolve();
    });
  });
}

function conclusion({ packets, telemetry, firstSendAtMs }) {
  const ok = packets.find((packet) => packet.text?.toLowerCase() === 'ok');
  if (ok) {
    return `The drone answers "ok" (from port ${ok.fromPort} to local port ${ok.localPort}). The control channel works.`;
  }
  if (packets.length) {
    return 'Packets arrive from the drone on the control ports, but none is "ok". See the report.';
  }
  if (telemetry.packets > 0 && firstSendAtMs !== null && telemetry.firstAtMs !== null && telemetry.firstAtMs > firstSendAtMs) {
    return 'Telemetry started only after our "command": the drone receives the Mac\'s commands, but no 8889 reply reached any listening port.';
  }
  if (telemetry.packets > 0) {
    return 'Telemetry was already flowing before our "command": the drone was already in SDK mode (maybe from an earlier client). No control reply reached any listening port. Next: power-cycle the drone and run this again right away.';
  }
  return 'Neither control replies nor telemetry. Cause unknown; ping and ARP do not prove UDP 8889 works.';
}

async function main() {
  console.log('Tello EDU diagnostics: checking en0…');
  const en0Address = en0TelloAddress();
  const reportPath = fileURLToPath(new URL('../.tello-diagnostics.json', import.meta.url));
  if (!en0Address) {
    const report = {
      target: { host: TARGET, commandPort: COMMAND_PORT },
      aborted: true,
      reason: 'en0 has no 192.168.10.x IPv4 address',
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.error('Stopped before sending anything: en0 has no 192.168.10.x IPv4 address.');
    process.exitCode = 1;
    return;
  }

  console.log(`Target ${TARGET}:${COMMAND_PORT}; en0 ${en0Address}.`);
  const telemetry = await startTelemetry();
  const sniffers = await openSniffers([
    ['0.0.0.0', 8889],
    ['0.0.0.0', 9000],
    ['0.0.0.0', 0],
    [en0Address, 0],
  ]);
  const packets = [];
  recordReplies(sniffers, packets);
  for (const entry of sniffers) {
    console.log(`Local port ${entry.requested.address}:${entry.requested.port} → ${entry.bound ? `listening on ${entry.bound.port}` : `not opened (${entry.error})`}`);
  }

  console.log('Listening for 3 s before sending anything…');
  await wait(3000);
  const telemetryBeforeCommand = telemetry.result.packets;
  console.log(`Telemetry before the first "command": ${telemetryBeforeCommand} packets.`);

  const networkPromise = inspectNetwork();
  let firstSendAtMs = null;
  for (const entry of sniffers) {
    if (!entry.bound) continue;
    await sendCommand(entry);
    firstSendAtMs ??= entry.sentAtMs;
    console.log(`"command" sent from port ${entry.bound.port}${entry.sendError ? ` (error ${entry.sendError})` : ''}.`);
    await wait(2500);
  }
  console.log('Waiting 3 s more for late replies…');
  await wait(3000);

  const network = await networkPromise;
  for (const entry of sniffers) closeSocket(entry.socket);
  closeSocket(telemetry.socket);

  // If a reply arrived, confirm with the existing validated probe from the port that got it.
  const okPacket = packets.find((packet) => packet.text?.toLowerCase() === 'ok');
  const followUp = okPacket
    ? await probe({ host: TARGET, commandPort: COMMAND_PORT, localAddress: '0.0.0.0', localPort: okPacket.localPort })
    : null;

  const finalConclusion = conclusion({ packets, telemetry: telemetry.result, firstSendAtMs });
  const report = {
    generatedAt: new Date().toISOString(),
    target: { host: TARGET, commandPort: COMMAND_PORT, expectedMac: EXPECTED_MAC },
    local: { interface: 'en0', address: en0Address },
    network,
    telemetry: { ...telemetry.result, packetsBeforeFirstCommand: telemetryBeforeCommand, firstCommandAtMs: firstSendAtMs },
    controlSockets: sniffers.map(({ requested, bound, error, sentAtMs, sendError, otherSenders }) => ({ requested, boundPort: bound?.port ?? null, error, sentAtMs, sendError, otherSenders })),
    controlPackets: packets,
    followUp,
    conclusion: finalConclusion,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Ping replies: ${network.ping.received}/2; route: ${network.route.interface ?? 'not found'}; target ARP: ${network.arp.mac ?? 'not found'}.`);
  console.log(`Telemetry from the drone: ${telemetry.result.packets} packets (first at ${telemetry.result.firstAtMs ?? '-'} ms; first "command" at ${firstSendAtMs ?? '-'} ms).`);
  if (telemetry.result.latest.bat !== undefined) console.log(`Battery (telemetry): ${telemetry.result.latest.bat}%.`);
  console.log(`Packets from the drone on control ports: ${packets.length}.`);
  for (const packet of packets) console.log(`  ${packet.atMs} ms: from ${packet.fromPort} to local port ${packet.localPort}, ${packet.bytes} bytes${packet.text ? ` ("${packet.text}")` : ''}.`);
  if (followUp?.battery.status === 'ok') console.log(`Battery (SDK): ${followUp.battery.value}%.`);
  if (followUp?.sdk.status === 'ok') console.log(`SDK version: ${followUp.sdk.value}.`);
  if (telemetry.result.errors.length) console.log(`Telemetry listener error: ${telemetry.result.errors.join(', ')}.`);
  console.log(finalConclusion);
  console.log('Report written to .tello-diagnostics.json. No flight or Wi-Fi command sent.');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  await main();
}
