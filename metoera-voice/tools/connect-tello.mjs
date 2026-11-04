import dgram from 'node:dgram';
import os from 'node:os';
import {readFile, writeFile} from 'node:fs/promises';
const configPath = new URL('../.env.tello', import.meta.url);
const reportPath = new URL('../.tello-station-result.json', import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = Date.now() + 120000;
async function finish(result) {
  await writeFile(reportPath, JSON.stringify({...result, checkedAt:new Date().toISOString()}, null, 2), {mode:0o600});
  if (result.ok) console.log('Done: Tello configured. Wait for it to reboot, then put the Mac back on hackathon.');
  else if (result.reason === 'identity_mismatch' || result.reason === 'identity_unavailable') console.log('Stopped: serial number not confirmed. No network changed. See .tello-station-result.json.');
  else if (result.reason === 'wifi_timeout') console.log('Tello network not found. Join the Mac to the TELLO-XXXXXX network and run again.');
  else if (result.reason === 'no_sdk_response') console.log('The drone did not answer. No network changed.');
  else if (result.stage === 'station_command') console.log('Configuration not confirmed. Put the Mac back on hackathon and check.');
  else console.log('Stopped. Put the Mac back on hackathon.');
}
async function configuration() {
  const text = await readFile(configPath, 'utf8');
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(TELLO_SETUP_SSID|TELLO_SETUP_PASSWORD|TELLO_SETUP_SERIAL)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return {ssid:values.TELLO_SETUP_SSID, password:values.TELLO_SETUP_PASSWORD, serial:values.TELLO_SETUP_SERIAL};
}
// The Tello always replies to local port 8889. A late "ok" from an earlier command can
// arrive after the next query is sent, so each query only accepts a reply of its own shape.
const ACCEPT = {
  'command': text => /^ok$/i.test(text),
  'sn?': text => /^[A-Z0-9]{8,}$/i.test(text) && !/^ok$/i.test(text),
  'battery?': text => /^\d{1,3}$/.test(text),
};
async function query(socket, command) {
  const accept = ACCEPT[command] ?? (() => true);
  return new Promise(resolve => {
    let timeout;
    const complete = result => { clearTimeout(timeout); socket.off('message', receive); resolve(result); };
    const receive = (bytes, peer) => {
      if (peer.address !== '192.168.10.1' || peer.port !== 8889) return;
      const text = bytes.toString().replaceAll('\0','').trim();
      if (accept(text) || /^error\b/i.test(text)) complete(text);
    };
    socket.on('message', receive);
    timeout = setTimeout(() => complete(null), 5000);
    socket.send(command, 8889, '192.168.10.1', err => { if (err) complete(null); });
  });
}
console.log('Waiting for the Tello network. This check never starts the motors.');
let finished = false;
let sawDroneNetwork = false;
while (Date.now() < until && !finished) {
  let config;
  try { config = await configuration(); } catch { await pause(1500); continue; }
  if (!config.ssid || !config.password || !config.serial) { await pause(1500); continue; }
  if (config.ssid !== 'hackathon' || !/^[A-Za-z0-9]+$/.test(config.serial) || /\s/.test(config.ssid) || /\s/.test(config.password)) {
    await finish({ok:false,stage:'configuration',reason:'invalid_configuration'}); finished=true; break;
  }
  const local = (os.networkInterfaces().en0 ?? []).find(item => item.family === 'IPv4' && item.address.startsWith('192.168.10.'))?.address;
  if (!local) { await pause(1500); continue; }
  if (!sawDroneNetwork) console.log('Tello network found. Checking the SDK link and serial number…');
  sawDroneNetwork = true;
  await writeFile(reportPath, JSON.stringify({ok:false,stage:'connection',reason:'attempting_sdk'}), {mode:0o600});
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(8889, local, resolve); });
    let ready = null;
    for (let attempt = 0; attempt < 3 && ready !== 'ok'; attempt++) ready = (await query(socket, 'command'))?.toLowerCase() ?? null;
    if (ready !== 'ok') { await writeFile(reportPath, JSON.stringify({ok:false,stage:'connection',reason:'retrying_sdk'}), {mode:0o600}); await pause(1500); continue; }
    await pause(500); // let any late "ok" from retried commands arrive and be ignored
    const serial = await query(socket, 'sn?');
    if (serial?.toUpperCase() !== config.serial.toUpperCase()) {
      const value=serial?.toUpperCase() ?? '';
      const isError=value.startsWith('ERROR');
      const differences=/^[A-Z0-9]+$/.test(value)&&!isError ? [...value].map((char,i)=>char===config.serial.toUpperCase()[i]?null:i+1).filter(Boolean) : [];
      await finish({ok:false,stage:'identity',reason:serial?'identity_mismatch':'identity_unavailable',responseIsError:isError,responseWasOk:value==='OK',serialTail:/^[A-Z0-9]{8,}$/.test(value)?value.slice(-4):null,receivedSerial:/^[A-Z0-9]{8,20}$/.test(value)?value:null,serialLength:value.length,expectedLength:config.serial.length,differences}); finished=true; continue;
    }
    const battery=await query(socket, 'battery?');
    const response=await query(socket, `ap ${config.ssid} ${config.password}`);
    if (response && /^ok(?:[,\s]|$)/i.test(response)) await finish({ok:true,stage:'station_configured',identityMatched:true,batteryPercent:/^\d{1,3}$/.test(battery ?? '')?Number(battery):null,network:'hackathon'});
    else await finish({ok:false,stage:'station_command',reason:response?'drone_rejected':'response_missing',identityMatched:true});
    finished=true;
  } catch { await finish({ok:false,stage:'connection',reason:'network_error'}); finished=true; }
  finally { try { socket.close(); } catch {} }
}
if (!finished) await finish({ok:false,stage:'waiting',reason:sawDroneNetwork?'no_sdk_response':'wifi_timeout'});
