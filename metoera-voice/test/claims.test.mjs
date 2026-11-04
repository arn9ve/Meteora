import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { Claims, broadcastAddresses, clientName, parseAnnouncement, parsePeers, udpTransport } from '../src/claims.ts';

const BLACK = { id: 'tello', serial: '0TQZTEST000001', address: '192.168.5.137' };
const RED = { id: 'rmtt', serial: '0TQZTEST000002', address: '192.168.5.229' };
const LANDED = () => ({ flight: 'landed', battery: 80, connected: true });

// An in-memory Wi-Fi with a fake clock. Every message reaches every laptop (like a broadcast),
// delivered after each round so nothing runs re-entrantly. `lose(name)` drops a laptop's messages.
function network() {
  let now = 0;
  const queue = [];
  const nodes = [];
  const lost = new Set();
  const make = (name, specs, { id, status = LANDED } = {}) => {
    const node = { listener: null };
    const transport = {
      send(data) { if (!lost.has(name)) queue.push(data); },
      onMessage(listener) { node.listener = listener; },
      close() { node.listener = null; },
    };
    node.claims = new Claims({ drones: specs, status, transport, clientId: id ?? `${name}-0000-id`, name, now: () => now });
    nodes.push(node);
    node.claims.tick(); // what start() does first; the rounds then come from step()
    flush();
    return node.claims;
  };
  const flush = () => {
    while (queue.length) {
      const data = queue.shift();
      for (const node of nodes) node.listener?.(data);
    }
  };
  // Advance the clock by `ms`, `times` rounds: every laptop announces, then messages arrive.
  const step = (ms, times = 1) => {
    for (let i = 0; i < times; i += 1) {
      now += ms;
      for (const node of nodes) if (node.listener) node.claims.tick();
      flush();
    }
  };
  return { make, step, flush, lose: (name) => lost.add(name), inject: (message) => { queue.push(Buffer.from(JSON.stringify(message))); flush(); } };
}

test('a free drone is claimed only after listening for other laptops, then announcing the claim', () => {
  const net = network();
  const a = net.make('Barry', [BLACK]);
  net.step(500, 3); // 1.5 s: still listening
  assert.deepEqual(a.ownership('tello'), { state: 'waiting' });
  assert.match(a.refusal('tello'), /Checking that no other laptop/);
  net.step(500); // 2 s: claims it
  assert.deepEqual(a.ownership('tello'), { state: 'claiming' });
  net.step(500, 3); // 1.5 s later nobody objected
  assert.deepEqual(a.ownership('tello'), { state: 'mine', conflict: null });
  assert.equal(a.refusal('tello'), null);
});

test('a drone another laptop owns is see-only here: Connected to <name>', () => {
  const net = network();
  const a = net.make('Barry', [BLACK]);
  net.step(500, 8);
  assert.equal(a.refusal('tello'), null);
  const b = net.make('Arnove', [BLACK, RED]); // B lists both drones; A flies Black
  net.step(500, 8);
  assert.equal(b.refusal('tello'), 'Connected to Barry');
  const seen = b.ownership('tello');
  assert.equal(seen.state, 'other');
  assert.deepEqual([seen.owner, seen.drone.battery, seen.drone.flight], ['Barry', 80, 'landed']);
  assert.equal(b.refusal('rmtt'), null); // nobody else flies Red, so B takes it
  assert.equal(a.refusal('tello'), null);
  assert.deepEqual(a.clients().map((c) => c.name), ['Arnove']);
  assert.deepEqual(b.elsewhere().map((e) => [e.owner, e.drone.id]), [['Barry', 'tello']]);
});

test('two laptops claiming the same drone at once: the lower client id wins', () => {
  const net = network();
  const a = net.make('Barry', [BLACK], { id: 'aaaaaaaa-0001' });
  const b = net.make('Arnove', [BLACK], { id: 'bbbbbbbb-0002' });
  net.step(500, 10);
  assert.equal(a.refusal('tello'), null);
  assert.equal(b.refusal('tello'), 'Connected to Barry');
});

test('an owner never gives its drone up to a later claim, but shows a conflict', () => {
  const net = network();
  const a = net.make('Barry', [BLACK], { id: 'mmmmmmmm-0001' });
  net.step(500, 8);
  const rival = (state) => ({ v: 1, app: 'metoera', client: { id: 'aaaaaaaa-9999', name: 'Intruder' }, drones: [{ ...BLACK, state, flight: 'landed', battery: 50, connected: true }] });
  net.inject(rival('claiming')); // a lower id claiming after the fact changes nothing
  net.step(500, 4);
  assert.deepEqual(a.ownership('tello'), { state: 'mine', conflict: null });
  net.inject(rival('owned')); // split brain: both say they own it
  assert.deepEqual(a.ownership('tello'), { state: 'mine', conflict: 'Intruder' });
  assert.equal(a.refusal('tello'), null);
});

test('a silent owner frees its drone; one that was flying is held until it has landed by itself', () => {
  const net = network();
  const a = net.make('Barry', [BLACK], { status: () => ({ flight: 'flying', battery: 70, connected: true }) });
  net.step(500, 8);
  const b = net.make('Arnove', [BLACK]);
  net.step(500, 6);
  assert.equal(b.refusal('tello'), 'Connected to Barry');
  net.lose('Barry'); // Barry's laptop drops off the Wi-Fi
  net.step(500, 8); // 4 s: Barry is gone, but Black was flying
  assert.equal(b.ownership('tello').state, 'lost');
  assert.match(b.refusal('tello'), /Barry stopped answering .* lands by itself/);
  net.step(500, 30); // 15 s more: still held (20 s in total)
  assert.equal(b.ownership('tello').state, 'lost');
  net.step(500, 14);
  assert.equal(b.refusal('tello'), null);
  assert.equal(a.refusal('tello'), null); // A never heard otherwise; it is cut off, so it cannot reach the drone either
});

test('a silent owner of a landed drone frees it after 3.5 s', () => {
  const net = network();
  net.make('Barry', [BLACK]);
  net.step(500, 8);
  const b = net.make('Arnove', [BLACK]);
  net.step(500, 6);
  net.lose('Barry');
  net.step(500, 7); // 3.5 s of silence: Barry is not forgotten yet
  assert.equal(b.refusal('tello'), 'Connected to Barry');
  net.step(500, 4); // forgotten at the next round, then the 1.5 s claim
  assert.equal(b.refusal('tello'), null);
});

test('a laptop that stops says goodbye: its drones are free without waiting for the timeout', () => {
  const net = network();
  const a = net.make('Barry', [BLACK]);
  net.step(500, 8);
  const b = net.make('Arnove', [BLACK]);
  net.step(500, 6);
  assert.equal(b.refusal('tello'), 'Connected to Barry');
  a.close();
  net.flush();
  assert.deepEqual(b.clients(), []);
  net.step(500, 4); // only the 1.5 s claim, not the 3.5 s timeout
  assert.equal(b.refusal('tello'), null);
});

test('a laptop ignores its own announcements', () => {
  const net = network();
  const a = net.make('Barry', [BLACK]);
  net.step(500, 8);
  assert.deepEqual(a.clients(), []);
  assert.equal(a.refusal('tello'), null);
});

test('malformed, oversized or out-of-range announcements are ignored', () => {
  const good = { v: 1, app: 'metoera', client: { id: 'aaaaaaaa-0001', name: 'Barry' }, drones: [{ ...BLACK, state: 'owned', flight: 'landed', battery: 80, connected: true }] };
  const parse = (value) => parseAnnouncement(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  assert.equal(parse(good).client.name, 'Barry');
  const bad = [
    'not json',
    { ...good, app: 'other' },
    { ...good, v: 2 },
    { ...good, client: { id: 'x', name: 'Barry' } },
    { ...good, client: { id: 'aaaaaaaa-0001', name: 'Bar\nry' } },
    { ...good, drones: [{ ...good.drones[0], serial: 'short' }] },
    { ...good, drones: [{ ...good.drones[0], address: '192.168.5.300' }] },
    { ...good, drones: [{ ...good.drones[0], battery: 150 }] },
    { ...good, drones: [{ ...good.drones[0], state: 'stolen' }] },
    { ...good, drones: Array.from({ length: 9 }, () => good.drones[0]) },
    { ...good, padding: 'x'.repeat(3000) },
  ];
  for (const message of bad) assert.equal(parse(message), null, JSON.stringify(message).slice(0, 80));
});

test('helpers: broadcast addresses, METOERA_PEERS and the client name', () => {
  const interfaces = {
    en0: [{ family: 'IPv4', internal: false, address: '192.168.5.20', netmask: '255.255.255.0' }, { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff::' }],
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    en1: [{ family: 'IPv4', internal: false, address: '10.1.2.3', netmask: '255.255.0.0' }],
  };
  assert.deepEqual(broadcastAddresses(interfaces), ['192.168.5.255', '10.1.255.255']);
  assert.deepEqual(parsePeers(' 192.168.5.31, 192.168.5.40:18800', 18789), [{ address: '192.168.5.31', port: 18789 }, { address: '192.168.5.40', port: 18800 }]);
  assert.deepEqual(parsePeers(undefined), []);
  assert.throws(() => parsePeers('laptop.local'), /METOERA_PEERS/);
  assert.equal(clientName(undefined, 'Barrys-MacBook.local'), 'Barrys-MacBook');
  assert.equal(clientName('  Arnove  ', 'whatever'), 'Arnove');
  assert.equal(clientName(undefined, 'Café\u0007'), 'Caf');
});

async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('over real UDP: the second laptop sees the first one\'s drone as connected to it', async (t) => {
  const [portA, portB] = [await freeUdpPort(), await freeUdpPort()];
  const fast = { announceMs: 40, warmupMs: 120, claimMs: 120, peerTimeoutMs: 300 };
  const ta = await udpTransport({ port: portA, peers: [{ address: '127.0.0.1', port: portB }], broadcast: false });
  const tb = await udpTransport({ port: portB, peers: [{ address: '127.0.0.1', port: portA }], broadcast: false });
  const a = new Claims({ drones: [BLACK], status: LANDED, transport: ta, name: 'Barry', ...fast });
  const b = new Claims({ drones: [BLACK], status: LANDED, transport: tb, name: 'Arnove', ...fast, peerTimeoutMs: 5000 });
  t.after(async () => { await a.close(); await b.close(); });
  a.start();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(a.refusal('tello'), null);
  b.start();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(b.refusal('tello'), 'Connected to Barry');
  // Goodbye: B takes Black after its claim wait. B's peer timeout is 5 s here, so only a
  // goodbye that really left A's socket explains the handover.
  await a.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(b.refusal('tello'), null);
});

test('before start() a laptop only listens: it never claims or announces', () => {
  let now = 0;
  const sent = [];
  let listener = null;
  const b = new Claims({ drones: [BLACK], status: LANDED, transport: { send: (d) => sent.push(d), onMessage: (l) => { listener = l; }, close() {} }, name: 'Arnove', now: () => now });
  const other = { v: 1, app: 'metoera', client: { id: 'aaaaaaaa-0001', name: 'Barry' }, drones: [] };
  for (let i = 0; i < 20; i += 1) { now += 500; listener(Buffer.from(JSON.stringify(other))); }
  assert.deepEqual(sent, []);
  assert.deepEqual(b.ownership('tello'), { state: 'waiting' });
  assert.deepEqual(b.clients().map((c) => c.name), ['Barry']); // it did hear Barry
});
