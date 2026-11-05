// Which laptop flies which drone.
//
// Every meteora-voice server announces the drones it holds on the local network about once a
// second (UDP, broadcast on port 18789) and listens to the other laptops. A drone that another
// laptop holds gets no packet from this server: the Tello SDK has no notion of an owner, and
// any `command` from here could pull that drone's telemetry and video away from the laptop
// that flies it.
//
// Holding a drone listed in .env.tello: listen for a while after start, then announce
// "claiming" and wait. If nobody holds it and no laptop with a lower id claims it too, it is
// ours. A drone that is flying (or has a pilot, or is busy) is locked: its laptop never gives
// it up. A landed, idle drone is handed over to another laptop that asks for it in order to
// take off (`request`): the holder stops its video, says it let go, and the other laptop
// takes it.
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
/** A person's name as the page sends it (src/pilots.ts cleans it the same way). */
export const PILOT_NAME = /^[\p{L}\p{N} ._-]{1,24}$/u;

export type Flight = 'landed' | 'flying';
/** A drone this laptop lists in .env.tello. */
export type DroneSpec = { id: string; serial: string | null; address: string };
/**
 * What this laptop knows about one of its drones, sent along in the announcement.
 * `locked`: flying, flown by a pilot, or busy with a command. A locked drone is never handed over.
 */
export type DroneStatus = { flight: Flight; battery: number | null; connected: boolean; pilot?: string | null; locked?: boolean };
export type AnnouncedDrone = DroneSpec & {
  flight: Flight;
  battery: number | null;
  connected: boolean;
  pilot: string | null;
  locked: boolean;
  state: 'claiming' | 'owned';
  /** On a claim: this laptop asks for the drone in order to take off, even from its holder. */
  want?: boolean;
};
export type Announcement = {
  v: 1;
  app: 'metoera'; // network protocol id: kept as it was so laptops running older versions still understand each other
  client: { id: string; name: string };
  drones: AnnouncedDrone[];
  /** Sent once when a server stops: its drones are free at once. */
  bye?: boolean;
};

export type Ownership =
  | { state: 'waiting' } // listening for other laptops, or another laptop with a lower id is claiming it
  | { state: 'claiming' } // announced; nobody has objected yet
  | { state: 'mine'; conflict: string | null } // conflict: another laptop also says it holds it
  | { state: 'yielding'; to: string } // handing it over to the laptop that asked for it
  | { state: 'taking'; from: string | null } // asked for it in order to take off; waiting for the handover
  | { state: 'other'; owner: string; drone: AnnouncedDrone }
  | { state: 'lost'; owner: string; until: number }; // its holder went silent while it was locked (flying)

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
  /** The name people use for a drone ("Black"); the drone id by default. */
  label?: (id: string) => string;
  now?: () => number;
  announceMs?: number;
  peerTimeoutMs?: number;
  lostHoldMs?: number;
  warmupMs?: number;
  claimMs?: number;
  /** How long `request` waits for the holder to hand the drone over. */
  requestMs?: number;
  /** Runs before a drone is handed over (stop its video). The drone is let go when it settles. */
  onYield?: (id: string) => void | Promise<void>;
  onChange?: () => void;
};

type Peer = { name: string; drones: AnnouncedDrone[]; lastSeen: number };
type Want = { since: number; deadline: number; promise: Promise<string | null>; resolve: (refusal: string | null) => void };
type Own = { state: 'waiting' | 'claiming' | 'owned' | 'yielding'; since: number; want: Want | null; yieldTo: string };

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
  const { id, serial, address, state, flight, battery, connected, pilot, locked, want } = value;
  if (typeof id !== 'string' || !DRONE_ID.test(id)) return null;
  if (serial !== null && (typeof serial !== 'string' || !SERIAL.test(serial))) return null;
  if (typeof address !== 'string' || !IPV4.test(address)) return null;
  if (state !== 'claiming' && state !== 'owned') return null;
  if (flight !== 'landed' && flight !== 'flying') return null;
  if (battery !== null && (typeof battery !== 'number' || !Number.isInteger(battery) || battery < 0 || battery > 100)) return null;
  if (typeof connected !== 'boolean') return null;
  // pilot, locked and want are newer: an announcement without them still counts.
  if (pilot !== undefined && pilot !== null && (typeof pilot !== 'string' || !PILOT_NAME.test(pilot))) return null;
  if (locked !== undefined && typeof locked !== 'boolean') return null;
  if (want !== undefined && typeof want !== 'boolean') return null;
  return {
    id, serial, address, state, flight, battery, connected,
    pilot: typeof pilot === 'string' ? pilot : null,
    locked: typeof locked === 'boolean' ? locked : flight === 'flying',
    ...(want && state === 'claiming' ? { want: true } : {}),
  };
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

/** The name other laptops show: METEORA_CLIENT_NAME, or this computer's name. */
export function clientName(configured = process.env.METEORA_CLIENT_NAME, host = os.hostname()): string {
  const raw = (configured?.trim() || host.replace(/\.local$/i, '')).replace(/[^\x20-\x7e]/g, '').trim();
  return (raw || 'meteora').slice(0, 40);
}

/** "Black is flown by Amir on Barry's laptop", or the landed variant: what another laptop's drone allows. */
export function describeElsewhere(label: string, owner: string, drone: { flight: Flight; pilot: string | null; locked: boolean }): string {
  if (drone.pilot) return `${label} is flown by ${drone.pilot} on ${owner}'s laptop`;
  if (drone.locked) return `${label} is ${drone.flight === 'flying' ? 'flying' : 'busy'}, controlled from ${owner}'s laptop`;
  return `${label} is on the ground, linked to ${owner}'s laptop: say take off to fly it from here`;
}

export class Claims {
  readonly id: string;
  readonly name: string;
  readonly #specs: DroneSpec[];
  readonly #status: (id: string) => DroneStatus;
  readonly #transport: ClaimsTransport;
  readonly #label: (id: string) => string;
  readonly #now: () => number;
  readonly #announceMs: number;
  readonly #peerTimeoutMs: number;
  readonly #lostHoldMs: number;
  readonly #warmupMs: number;
  readonly #claimMs: number;
  readonly #requestMs: number;
  readonly #onYield: ((id: string) => void | Promise<void>) | undefined;
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
    this.#label = options.label ?? ((id) => id);
    this.#now = options.now ?? Date.now;
    this.#announceMs = options.announceMs ?? 1000;
    this.#peerTimeoutMs = options.peerTimeoutMs ?? 3500;
    this.#lostHoldMs = options.lostHoldMs ?? 20_000;
    this.#warmupMs = options.warmupMs ?? 2000;
    this.#claimMs = options.claimMs ?? 1500;
    this.#requestMs = options.requestMs ?? 6000;
    this.#onYield = options.onYield;
    this.#onChange = options.onChange;
    for (const spec of this.#specs) this.#mine.set(spec.id, { state: 'waiting', since: 0, want: null, yieldTo: '' });
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

  /**
   * The status of one of this laptop's drones changed (a pilot took off, it landed): tell the
   * others now instead of at the next round, and hand it over at once if someone asked for it.
   */
  refresh(): void {
    if (this.#closed || this.#startedAt === null) return;
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
      for (const drone of message.drones) this.#lost.delete(droneKey(drone)); // its holder is back
    }
    // Answer a change at once when our own state moves, never on every message (no storms).
    // Before start() nothing is claimed or announced: the laptop only listens.
    if (this.#startedAt !== null && this.#evaluate()) this.#announce();
  }

  /**
   * Ask for a drone in order to take off. Resolves null once it is ours (at once when it
   * already is), otherwise with the reason: another laptop flies it, or did not let go in time.
   */
  request(id: string): Promise<string | null> {
    const spec = this.#specs.find((s) => s.id === id);
    const own = this.#mine.get(id);
    if (!spec || !own) return Promise.resolve('This drone is not configured on this laptop');
    if (own.state === 'owned') return Promise.resolve(null);
    if (own.want) return own.want.promise;
    const refused = this.#blockedFor(spec, own);
    if (refused) return Promise.resolve(refused);
    let resolve!: (refusal: string | null) => void;
    const promise = new Promise<string | null>((r) => { resolve = r; });
    const now = this.#now();
    own.want = { since: now, deadline: now + this.#requestMs, promise, resolve };
    this.#evaluate();
    this.#announce();
    this.#onChange?.();
    // Check again right when the claim wait is over, not only at the next round.
    if (this.#timer) setTimeout(() => this.tick(), this.#claimMs + 20).unref();
    return promise;
  }

  ownership(id: string): Ownership | null {
    const spec = this.#specs.find((s) => s.id === id);
    const own = this.#mine.get(id);
    if (!spec || !own) return null;
    const owner = this.#find(spec, 'owned');
    if (own.state === 'owned') return { state: 'mine', conflict: owner?.peer.name ?? null };
    if (own.state === 'yielding') return { state: 'yielding', to: own.yieldTo };
    if (own.want) return { state: 'taking', from: owner?.peer.name ?? null };
    if (owner) return { state: 'other', owner: owner.peer.name, drone: owner.drone };
    const hold = this.#lost.get(droneKey(spec));
    if (hold) return { state: 'lost', owner: hold.owner, until: hold.until };
    return own.state === 'claiming' ? { state: 'claiming' } : { state: 'waiting' };
  }

  /** Null when this laptop may command the drone; otherwise why not, ready to show. */
  refusal(id: string): string | null {
    const ownership = this.ownership(id);
    const label = this.#label(id);
    if (!ownership) return 'This drone is not configured on this laptop';
    if (ownership.state === 'mine') return null;
    if (ownership.state === 'yielding') return `Handing ${label} over to ${ownership.to}'s laptop`;
    if (ownership.state === 'taking') return `Taking ${label} over${ownership.from ? ` from ${ownership.from}'s laptop` : ''}…`;
    if (ownership.state === 'other') return describeElsewhere(label, ownership.owner, ownership.drone);
    if (ownership.state === 'lost') return `${ownership.owner} stopped answering while ${label} was flying; it lands by itself`;
    return 'Checking that no other laptop controls this drone';
  }

  /**
   * Null when a packet may leave toward the drone. Same as `refusal`, except while handing the
   * drone over: its video still has to be stopped.
   */
  mayTalk(id: string): string | null {
    return this.#mine.get(id)?.state === 'yielding' ? null : this.refusal(id);
  }

  /** Drones held by other laptops, with the holder's name. */
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
    for (const own of this.#mine.values()) this.#settleWant(own, 'This laptop is shutting down');
    this.#announce(true);
    this.#closed = true;
    await this.#transport.close();
  }

  #find(spec: DroneSpec, state: 'owned' | 'claiming', better?: (clientId: string, drone: AnnouncedDrone) => boolean) {
    for (const [clientId, peer] of this.#peers) {
      const drone = peer.drones.find((d) => d.state === state && sameDrone(d, spec) && (!better || better(clientId, d)));
      if (drone) return { clientId, peer, drone };
    }
    return null;
  }

  /** Why a takeoff request cannot go through right now, or null while it may wait for a handover. */
  #blockedFor(spec: DroneSpec, own: Own): string | null {
    const label = this.#label(spec.id);
    if (this.#startedAt === null) return 'Checking that no other laptop controls this drone';
    if (own.state === 'yielding') return `Handing ${label} over to ${own.yieldTo}'s laptop`;
    const hold = this.#lost.get(droneKey(spec));
    if (hold) return `${hold.owner} stopped answering while ${label} was flying; it lands by itself`;
    // A holder that announced "locked" is not refused here: that announcement can be up to a
    // second old (its pilot may just have landed). The answer comes with its next one.
    return null;
  }

  #settleWant(own: Own, refusal: string | null): void {
    if (!own.want) return;
    const { resolve } = own.want;
    own.want = null;
    resolve(refusal);
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
        if (drone.state === 'owned' && drone.locked) this.#lost.set(droneKey(drone), { owner: peer.name, until: now + this.#lostHoldMs });
      }
    }
    for (const [key, hold] of this.#lost) if (hold.until <= now) { this.#lost.delete(key); peersChanged = true; }

    let mineChanged = false;
    const yields: string[] = [];
    for (const spec of this.#specs) {
      const own = this.#mine.get(spec.id)!;
      const before = own.state;
      const wantedElsewhere = (better?: (clientId: string) => boolean) => this.#find(spec, 'claiming', (clientId, d) => d.want === true && (!better || better(clientId)));
      if (own.state === 'owned') {
        // A landed, idle drone goes to a laptop that asks for it to take off; a locked one never.
        const asking = wantedElsewhere();
        if (asking && !this.#status(spec.id).locked) {
          own.state = 'yielding';
          own.yieldTo = asking.peer.name;
          yields.push(spec.id);
        }
      } else if (own.state !== 'yielding') {
        const started = this.#startedAt;
        const blocked = started === null || this.#find(spec, 'owned') || this.#lost.has(droneKey(spec)) || now - started < this.#warmupMs;
        if (blocked) own.state = 'waiting';
        else if (own.want) {
          // Asked for by several laptops at once: the lower client id wins. The wait counts from
          // the request, which every other laptop has heard all along.
          if (wantedElsewhere((clientId) => clientId < this.id)) own.state = 'waiting';
          else if (now - own.want.since >= this.#claimMs) own.state = 'owned';
          else own.state = 'claiming';
        }
        // A free drone is claimed for this laptop, but a laptop that asks for it to fly goes first.
        else if (wantedElsewhere()) own.state = 'waiting';
        else if (own.state === 'waiting') { own.state = 'claiming'; own.since = now; }
        else if (this.#find(spec, 'claiming', (clientId) => clientId < this.id)) own.state = 'waiting';
        else if (now - own.since >= this.#claimMs) own.state = 'owned';
      }
      if (own.want) {
        const label = this.#label(spec.id);
        const owner = this.#find(spec, 'owned');
        const hold = this.#lost.get(droneKey(spec));
        if (own.state === 'owned') this.#settleWant(own, null);
        // Only an announcement heard after the request counts: an older one may be stale.
        else if (owner?.drone.locked && owner.peer.lastSeen > own.want.since) this.#settleWant(own, describeElsewhere(label, owner.peer.name, owner.drone));
        else if (hold) this.#settleWant(own, `${hold.owner} stopped answering while ${label} was flying; it lands by itself`);
        else if (now >= own.want.deadline) this.#settleWant(own, owner ? `${owner.peer.name}'s laptop did not hand ${label} over; try again` : `Could not take ${label}: another laptop asked for it too`);
        if (!own.want && own.state !== 'owned') mineChanged = true;
      }
      if (own.state !== before) mineChanged = true;
    }
    for (const id of yields) this.#handOver(id);
    if (mineChanged || peersChanged) this.#onChange?.();
    return mineChanged;
  }

  /** Stop the drone's video (onYield), then let go: the laptop that asked takes it. */
  #handOver(id: string): void {
    void Promise.resolve()
      .then(() => this.#onYield?.(id))
      .catch(() => undefined)
      .then(() => {
        const own = this.#mine.get(id);
        if (this.#closed || own?.state !== 'yielding') return;
        own.state = 'waiting';
        own.since = this.#now();
        this.#evaluate();
        this.#announce();
        this.#onChange?.();
      });
  }

  #announce(bye = false): void {
    const drones: AnnouncedDrone[] = [];
    if (!bye) {
      for (const spec of this.#specs) {
        const own = this.#mine.get(spec.id)!;
        if (own.state === 'waiting' && !own.want) continue;
        const status = this.#status(spec.id);
        const held = own.state === 'owned' || own.state === 'yielding';
        drones.push({
          ...spec,
          flight: status.flight,
          battery: status.battery,
          connected: status.connected,
          // A name the others would reject would make them drop the whole announcement.
          pilot: status.pilot && PILOT_NAME.test(status.pilot) ? status.pilot : null,
          locked: status.locked ?? status.flight === 'flying',
          state: held ? 'owned' : 'claiming',
          ...(!held && own.want ? { want: true } : {}),
        });
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

/** METEORA_PEERS: `ip[:port],...` of laptops to reach directly when broadcasts are blocked. */
export function parsePeers(text: string | undefined, defaultPort = CLAIMS_PORT): { address: string; port: number }[] {
  const peers: { address: string; port: number }[] = [];
  for (const item of (text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [address, port] = item.split(':');
    const number = port === undefined ? defaultPort : Number(port);
    if (!address || !IPV4.test(address) || !Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`METEORA_PEERS: "${item}" is not ip[:port]`);
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
