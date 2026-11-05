// One UDP socket per local port, shared by every drone link in this process.
// Every Tello (EDU or RoboMaster TT) sends its replies to the computer's port 8889 and its
// telemetry to 8890, so two drones cannot each bind their own socket: the second bind fails
// with EADDRINUSE. Instead the links share one socket and each one only sees datagrams
// whose sender address is its own drone.
import dgram from 'node:dgram';

export type Datagram = { text: string; port: number };
type Listener = (datagram: Datagram) => void;

// Users are counted when they ask, not when the bind finishes, so a release that races
// a pending acquire cannot close the socket under it.
type Entry = { opening: Promise<UdpPort>; users: number };
const shared = new Map<number, Entry>();

function canonical(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export class UdpPort {
  readonly #socket: dgram.Socket;
  readonly #port: number;
  readonly #listeners = new Map<string, Listener>();
  #entry: Entry | null = null;

  private constructor(socket: dgram.Socket, port: number) {
    this.#socket = socket;
    this.#port = port;
    socket.on('error', () => undefined);
    socket.on('message', (payload, peer) => {
      const address = canonical(peer.address);
      const listener = this.#listeners.get(`${address}:${peer.port}`) ?? this.#listeners.get(address);
      listener?.({ text: payload.toString('utf8'), port: peer.port });
    });
  }

  /** Opens (or reuses) the socket bound to `port`. Port 0 always gets a private socket. */
  static acquire(port: number): Promise<UdpPort> {
    let entry = port === 0 ? undefined : shared.get(port);
    if (!entry) {
      const created: Entry = { opening: UdpPort.#bind(port), users: 0 };
      created.opening.then((udp) => { udp.#entry = created; }, () => { if (shared.get(port) === created) shared.delete(port); });
      if (port !== 0) shared.set(port, created);
      entry = created;
    }
    entry.users += 1;
    return entry.opening;
  }

  static #bind(port: number): Promise<UdpPort> {
    const socket = dgram.createSocket('udp4');
    return new Promise((resolve, reject) => {
      socket.once('error', (error) => { try { socket.close(); } catch { /* not bound */ } reject(error); });
      socket.bind(port, () => { socket.removeAllListeners('error'); resolve(new UdpPort(socket, port)); });
    });
  }

  get localPort(): number {
    return this.#socket.address().port;
  }

  /**
   * Delivers datagrams from `host` (and only from `remotePort`, when given) to `listener`.
   * One link per drone: a second subscription for the same sender is refused.
   */
  subscribe(host: string, listener: Listener, remotePort?: number): () => void {
    const key = remotePort === undefined ? canonical(host) : `${canonical(host)}:${remotePort}`;
    if (this.#listeners.has(key)) throw Object.assign(new Error(`${key} already has a link`), { code: 'EHOSTINUSE' });
    this.#listeners.set(key, listener);
    return () => { if (this.#listeners.get(key) === listener) this.#listeners.delete(key); };
  }

  send(text: string, port: number, host: string): Promise<Error | null> {
    return new Promise((resolve) => {
      try { this.#socket.send(text, port, host, (error) => resolve(error ?? null)); }
      catch (error) { resolve(error as Error); }
    });
  }

  /** Drops one user; the socket closes when the last link lets go. */
  release(): void {
    const entry = this.#entry;
    if (!entry || entry.users <= 0) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    if (shared.get(this.#port) === entry) shared.delete(this.#port);
    try { this.#socket.close(); } catch { /* already closed */ }
  }
}
