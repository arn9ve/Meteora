// Which laptop flies which drone.
//
// Every metoera-voice server announces the drones it controls on the local network about
// once a second (UDP, broadcast on port 18789) and listens to the other laptops. A drone that
// another laptop owns is see-only here: this server never sends it a single packet. The Tello
// SDK has no notion of an owner, and any `command` from here could pull that drone's telemetry
// and video away from the laptop that flies it.
//
// Claiming a drone listed in .env.tello: listen for a while after start, then announce
// "claiming" and wait. If nobody owns it and no laptop with a lower id claims it too, it is
// ours, and an owner never gives a drone up to a later claim.
import dgram from 'node:dgram';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const CLAIMS_PORT = 18789;
const MAX_MESSAGE = 2048;
const MAX_DRONES = 8;
const SERIAL = /^[A-Z0-9]{8,}$/i;
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const DRONE_ID = /^[a-z][a-z0-9_-]{0,15}$/;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const CLIENT_NAME = /^[\x20-\x7e]{1,40}$/;

export type Flight = 'landed' | 'flying';
/** A drone this laptop lists in .env.tello. */
export type DroneSpec = { id: string; serial: string | null; address: string };
/** What this laptop knows about one of its drones, sent along in the announcement. */
export type DroneStatus = { flight: Flight; battery: number | null; connected: boolean };
export type AnnouncedDrone = DroneSpec & DroneStatus & { state: 'claiming' | 'owned' };
export type Announcement = {
  v: 1;
  app: 'metoera';
  client: { id: string; name: string };
  drones: AnnouncedDrone[];
  /** Sent once when a server stops: its drones are free at once. */
  bye?: boolean;
};

export type Ownership =
  | { state: 'waiting' } // listening for other laptops, or another laptop with a lower id is claiming it
  | { state: 'claiming' } // announced; nobody has objected yet
  | { state: 'mine'; conflict: string | null } // conflict: another laptop also says it owns it
  | { state: 'other'; owner: string; drone: AnnouncedDrone }
  | { state: 'lost'; owner: string; until: number }; // its owner went silent while it was flying

export interface ClaimsTransport {
  send(data: Buffer): void;
  onMessage(listener: (data: Buffer) => void): void;
  /** Resolves once everything already sent has left (the goodbye must reach the others). */
  close(): void | Promise<void>;
}

export type ClaimsOptions = {
  drones: DroneSpec[];
  status: (id: string) => DroneStatus;
  transport: ClaimsTransport;
  clientId?: string;
  name?: string;
  now?: () => number;
  announceMs?: number;
  peerTimeoutMs?: number;
  lostHoldMs?: number;
  warmupMs?: number;
  claimMs?: number;
  onChange?: () => void;
};

type Peer = { name: string; drones: AnnouncedDrone[]; lastSeen: number };
type Own = { state: 'waiting' | 'claiming' | 'owned'; since: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Same drone on two laptops: same serial, or the same address when a serial is missing. */
function sameDrone(a: { serial: string | null; address: string }, b: { serial: string | null; address: string }): boolean {
  if (a.serial && b.serial) return a.serial.toUpperCase() === b.serial.toUpperCase();
  return a.address === b.address;
}

const droneKey = (d: { serial: string | null; address: string }) => (d.serial ? `sn:${d.serial.toUpperCase()}` : `ip:${d.address}`);

function parseDrone(value: unknown): AnnouncedDrone | null {
  if (!isRecord(value)) return null;
  const { id, serial, address, state, flight, battery, connected } = value;
  if (typeof id !== 'string' || !DRONE_ID.test(id)) return null;
  if (serial !== null && (typeof serial !== 'string' || !SERIAL.test(serial))) return null;
  if (typeof address !== 'string' || !IPV4.test(address)) return null;
  if (state !== 'claiming' && state !== 'owned') return null;
  if (flight !== 'landed' && flight !== 'flying') return null;
  if (battery !== null && (typeof battery !== 'number' || !Number.isInteger(battery) || battery < 0 || battery > 100)) return null;
  if (typeof connected !== 'boolean') return null;
  return { id, serial, address, state, flight, battery, connected };
}

/** A validated announcement, or null. Anyone on the Wi-Fi can send to this port. */
export function parseAnnouncement(data: Buffer): Announcement | null {
  if (data.length > MAX_MESSAGE) return null;
  let value: unknown;
  try { value = JSON.parse(data.toString('utf8')); } catch { return null; }
  if (!isRecord(value) || value.v !== 1 || value.app !== 'metoera' || !isRecord(value.client)) return null;
  const { id, name } = value.client;
  if (typeof id !== 'string' || !CLIENT_ID.test(id) || typeof name !== 'string' || !CLIENT_NAME.test(name)) return null;
  if (!Array.isArray(value.drones) || value.drones.length > MAX_DRONES) return null;
  const drones = value.drones.map(parseDrone);
  if (drones.some((d) => d === null)) return null;
  if (value.bye !== undefined && typeof value.bye !== 'boolean') return null;
  return { v: 1, app: 'metoera', client: { id, name }, drones: drones as AnnouncedDrone[], ...(value.bye ? { bye: true } : {}) };
}

/** The name other laptops show: METOERA_CLIENT_NAME, or this computer's name. */
export function clientName(configured = process.env.METOERA_CLIENT_NAME, host = os.hostname()): string {
  const raw = (configured?.trim() || host.replace(/\.local$/i, '')).replace(/[^\x20-\x7e]/g, '').trim();
  return (raw || 'metoera').slice(0, 40);
}

export class Claims {
  readonly id: string;
  readonly name: string;
  readonly #specs: DroneSpec[];
  readonly #status: (id: string) => DroneStatus;
  readonly #transport: ClaimsTransport;
  readonly #now: () => number;
  readonly #announceMs: number;
  readonly #peerTimeoutMs: number;
  readonly #lostHoldMs: number;
  readonly #warmupMs: number;
  readonly #claimMs: number;
  readonly #onChange: (() => void) | undefined;
  #startedAt: number | null = null; // claims only move after start(); the listening time counts from there
  readonly #peers = new Map<string, Peer>();
  readonly #lost = new Map<string, { owner: string; until: number }>();
  readonly #mine = new Map<string, Own>();
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: ClaimsOptions) {
    this.id = options.clientId ?? randomUUID();
    this.name = options.name ?? clientName();
    this.#specs = options.drones.map((d) => ({ ...d, serial: d.serial?.trim().toUpperCase() || null }));
    this.#status = options.status;
    this.#transport = options.transport;
    this.#now = options.now ?? Date.now;
    this.#announceMs = options.announceMs ?? 1000;
    this.#peerTimeoutMs = options.peerTimeoutMs ?? 3500;
    this.#lostHoldMs = options.lostHoldMs ?? 20_000;
    this.#warmupMs = options.warmupMs ?? 2000;
    this.#claimMs = options.claimMs ?? 1500;
    this.#onChange = options.onChange;
    for (const spec of this.#specs) this.#mine.set(spec.id, { state: 'waiting', since: 0 });
    this.#transport.onMessage((data) => this.receive(data));
  }

  /** Announce and re-check every `announceMs`. Until then, other laptops are only listened to. */
  start(): void {
    if (this.#timer || this.#closed) return;
    this.#startedAt ??= this.#now();
    this.tick();
    this.#timer = setInterval(() => this.tick(), this.#announceMs);
    this.#timer.unref();
  }

  /** One round: forget silent laptops, move claims along, announce. Starts the claims if needed. */
  tick(): void {
    if (this.#closed) return;
    this.#startedAt ??= this.#now();
    this.#evaluate();
    this.#announce();
  }

  receive(data: Buffer): void {
    if (this.#closed) return;
    const message = parseAnnouncement(data);
    if (!message || message.client.id === this.id) return;
    if (message.bye) this.#peers.delete(message.client.id);
    else {
      this.#peers.set(message.client.id, { name: message.client.name, drones: message.drones, lastSeen: this.#now() });
      for (const drone of message.drones) this.#lost.delete(droneKey(drone)); // its owner is back
    }
    // Answer a change at once when our own state moves, never on every message (no storms).
    // Before start() nothing is claimed or announced: the laptop only listens.
    if (this.#startedAt !== null && this.#evaluate()) this.#announce();
  }

  ownership(id: string): Ownership | null {
    const spec = this.#specs.find((s) => s.id === id);
    const own = this.#mine.get(id);
    if (!spec || !own) return null;
    const owner = this.#find(spec, 'owned');
    if (own.state === 'owned') return { state: 'mine', conflict: owner?.peer.name ?? null };
    if (owner) return { state: 'other', owner: owner.peer.name, drone: owner.drone };
    const hold = this.#lost.get(droneKey(spec));
    if (hold) return { state: 'lost', owner: hold.owner, until: hold.until };
    return own.state === 'claiming' ? { state: 'claiming' } : { state: 'waiting' };
  }

  /** Null when this laptop may talk to the drone; otherwise why not, ready to show. */
  refusal(id: string): string | null {
    const ownership = this.ownership(id);
    if (!ownership) return 'This drone is not configured on this laptop';
    if (ownership.state === 'mine') return null;
    if (ownership.state === 'other') return `Connected to ${ownership.owner}`;
    if (ownership.state === 'lost') return `${ownership.owner} stopped answering while this drone was flying; it lands by itself`;
    return 'Checking that no other laptop controls this drone';
  }

  /** Drones owned by other laptops, with the owner's name. */
  elsewhere(): { owner: string; drone: AnnouncedDrone }[] {
    const out: { owner: string; drone: AnnouncedDrone }[] = [];
    for (const peer of this.#peers.values()) {
      for (const drone of peer.drones) if (drone.state === 'owned') out.push({ owner: peer.name, drone });
    }
    return out;
  }

  /** The other laptops heard recently. */
  clients(): { name: string; lastSeen: number }[] {
    return [...this.#peers.values()].map((p) => ({ name: p.name, lastSeen: p.lastSeen }));
  }

  /** Stop announcing and tell the others our drones are free now. Await it before exiting. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#announce(true);
    this.#closed = true;
    await this.#transport.close();
  }

  #find(spec: DroneSpec, state: 'owned' | 'claiming', better?: (clientId: string) => boolean) {
    for (const [clientId, peer] of this.#peers) {
      if (better && !better(clientId)) continue;
      const drone = peer.drones.find((d) => d.state === state && sameDrone(d, spec));
      if (drone) return { clientId, peer, drone };
    }
    return null;
  }

  /** Returns true when one of this laptop's drones changed state. */
  #evaluate(): boolean {
    const now = this.#now();
    let peersChanged = false;
    for (const [clientId, peer] of this.#peers) {
      if (now - peer.lastSeen <= this.#peerTimeoutMs) continue;
      this.#peers.delete(clientId);
      peersChanged = true;
      // It may still be in the air: nobody claims it until it has landed by itself.
      for (const drone of peer.drones) {
        if (drone.state === 'owned' && drone.flight === 'flying') this.#lost.set(droneKey(drone), { owner: peer.name, until: now + this.#lostHoldMs });
      }
    }
    for (const [key, hold] of this.#lost) if (hold.until <= now) { this.#lost.delete(key); peersChanged = true; }

    let mineChanged = false;
    for (const spec of this.#specs) {
      const own = this.#mine.get(spec.id)!;
      if (own.state === 'owned') continue; // an owner never gives a drone up
      const before = own.state;
      const started = this.#startedAt;
      const blocked = started === null || this.#find(spec, 'owned') || this.#lost.has(droneKey(spec)) || now - started < this.#warmupMs;
      if (blocked) own.state = 'waiting';
      else if (own.state === 'waiting') { own.state = 'claiming'; own.since = now; }
      else if (this.#find(spec, 'claiming', (clientId) => clientId < this.id)) own.state = 'waiting';
      else if (now - own.since >= this.#claimMs) own.state = 'owned';
      if (own.state !== before) mineChanged = true;
    }
    if (mineChanged || peersChanged) this.#onChange?.();
    return mineChanged;
  }

  #announce(bye = false): void {
    const drones: AnnouncedDrone[] = [];
    if (!bye) {
      for (const spec of this.#specs) {
        const own = this.#mine.get(spec.id)!;
        if (own.state === 'waiting') continue;
        drones.push({ ...spec, ...this.#status(spec.id), state: own.state === 'owned' ? 'owned' : 'claiming' });
      }
    }
    const message: Announcement = { v: 1, app: 'metoera', client: { id: this.id, name: this.name }, drones, ...(bye ? { bye: true } : {}) };
    try { this.#transport.send(Buffer.from(JSON.stringify(message))); } catch { /* offline: the next round tries again */ }
  }
}

/** Directed broadcast address of every IPv4 network this computer is on. */
export function broadcastAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !IPV4.test(entry.address) || !IPV4.test(entry.netmask)) continue;
      const ip = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      out.add(ip.map((octet, i) => (octet | (~mask[i]! & 255))).join('.'));
    }
  }
  return [...out];
}

/** METOERA_PEERS: `ip[:port],...` of laptops to reach directly when broadcasts are blocked. */
export function parsePeers(text: string | undefined, defaultPort = CLAIMS_PORT): { address: string; port: number }[] {
  const peers: { address: string; port: number }[] = [];
  for (const item of (text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [address, port] = item.split(':');
    const number = port === undefined ? defaultPort : Number(port);
    if (!address || !IPV4.test(address) || !Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`METOERA_PEERS: "${item}" is not ip[:port]`);
    peers.push({ address, port: number });
  }
  return peers;
}

/**
 * The real transport: one UDP socket, broadcast to every LAN plus the listed peers.
 * `broadcast: false` sends to the listed peers only (tests on one machine).
 */
export async function udpTransport(options: { port?: number; peers?: { address: string; port: number }[]; broadcast?: boolean } = {}): Promise<ClaimsTransport> {
  const port = options.port ?? CLAIMS_PORT;
  const broadcast = options.broadcast ?? true;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, () => { socket.off('error', reject); resolve(); });
  });
  socket.setBroadcast(true);
  socket.on('error', () => undefined);
  const peers = options.peers ?? [];
  let inFlight = 0;
  let drained: (() => void) | null = null;
  const sent = () => { inFlight -= 1; if (inFlight === 0) drained?.(); };
  return {
    send(data) {
      const targets = [...(broadcast ? broadcastAddresses().map((address) => ({ address, port })) : []), ...peers];
      for (const target of targets) {
        inFlight += 1;
        try { socket.send(data, target.port, target.address, sent); } catch { sent(); }
      }
    },
    onMessage(listener) { socket.on('message', (data) => listener(data)); },
    // Wait (at most 300 ms) for queued datagrams, so the goodbye is not dropped by the close.
    async close() {
      if (inFlight > 0) await new Promise<void>((resolve) => { drained = resolve; setTimeout(resolve, 300).unref(); });
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}
