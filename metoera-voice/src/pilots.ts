// Who flies which drone among the people using this laptop's server.
//
// Each browser (the laptop page, a phone on the link) is a session with a name the person
// types. The person who takes off a drone is its pilot until it is back on the ground and
// idle: nobody else can command it, not even land, stop or cut its motors. Only status, look
// and photo stay open to everyone. The lock goes by the name, not by the browser: two pages
// with the same name are the same pilot, and a pilot who changes name mid-flight can no
// longer command the drone. When no page with the pilot's name has been heard from for
// `timeoutMs`, `absent()` says so and the server lands the drone by itself.

/** Actions anyone may send, even to a drone someone else flies: they only read. */
export const READ_ONLY = new Set(['status', 'look', 'photo', 'describe', 'memory']);
/** Actions that start a flight: the person who sends one becomes the pilot. */
export const TAKEOFF = new Set(['takeoff', 'test_flight']);
export const PILOT_TIMEOUT_MS = 15_000;

/** The name as shown: letters, digits, space . _ - only, at most 24 characters. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
}
const keyOf = (name: string) => cleanName(name).toLowerCase();

export type PilotsOptions = {
  now?: () => number;
  timeoutMs?: number;
  /** The name people use for a drone ("Black"); the drone id by default. */
  label?: (id: string) => string;
};

export class Pilots {
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #label: (id: string) => string;
  readonly #sessions = new Map<string, { name: string; lastSeen: number }>();
  readonly #lastSeenByName = new Map<string, number>(); // name key -> last request from a page using it
  readonly #pilots = new Map<string, string>(); // droneId -> pilot name, as typed
  readonly #active = new Map<string, number>(); // droneId -> commands being sent right now

  constructor(options: PilotsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? PILOT_TIMEOUT_MS;
    this.#label = options.label ?? ((id) => id);
  }

  /** Every request from a page counts: the page polls the drones every 1.5 s. */
  seen(sid: string): void {
    const now = this.#now();
    const session = this.#sessions.get(sid) ?? { name: '', lastSeen: 0 };
    session.lastSeen = now;
    this.#sessions.set(sid, session);
    if (session.name) this.#lastSeenByName.set(keyOf(session.name), now);
  }

  /** Returns the cleaned name, or '' when nothing is left of it. */
  setName(sid: string, raw: unknown): string {
    const name = cleanName(raw);
    if (!name) return '';
    this.seen(sid);
    this.#sessions.get(sid)!.name = name;
    this.#lastSeenByName.set(keyOf(name), this.#now());
    return name;
  }

  nameOf(sid: string): string {
    return this.#sessions.get(sid)?.name ?? '';
  }

  /** Names heard from recently, once each. */
  online(): string[] {
    const now = this.#now();
    const names = new Map<string, string>();
    for (const s of this.#sessions.values()) if (s.name && now - s.lastSeen <= this.#timeoutMs) names.set(keyOf(s.name), s.name);
    return [...names.values()];
  }

  pilotOf(id: string): string | null {
    return this.#pilots.get(id) ?? null;
  }

  /** True when this page uses the pilot's name. */
  isPilot(sid: string, id: string): boolean {
    const pilot = this.#pilots.get(id);
    const name = this.nameOf(sid);
    return Boolean(pilot && name && keyOf(pilot) === keyOf(name));
  }

  /** Null when this person may send `action` to the drone; otherwise why not, ready to show. */
  check(sid: string, id: string, action: string): string | null {
    const pilot = this.#pilots.get(id);
    if (pilot && !this.isPilot(sid, id) && !READ_ONLY.has(action)) return `${this.#label(id)} is flown by ${pilot}. Only ${pilot} can command it until it lands.`;
    if (!pilot && TAKEOFF.has(action) && !this.nameOf(sid)) return 'Type your name first (top of the page): the person who takes off a drone flies it until it lands.';
    return null;
  }

  /** Switch off and Cut motors from this page reach the drone: nobody flies it, or this person does. */
  mayEmergency(sid: string, id: string): boolean {
    return !this.#pilots.has(id) || this.isPilot(sid, id);
  }

  /**
   * A command is about to go out. A takeoff makes this person the pilot, and so does any
   * command to a drone that flies without one. Pair it with `end` once the command is done.
   */
  begin(sid: string, id: string, action: string, flight: 'landed' | 'flying'): void {
    this.#active.set(id, (this.#active.get(id) ?? 0) + 1);
    const name = this.nameOf(sid);
    if (this.#pilots.has(id) || !name) return;
    if (TAKEOFF.has(action) || (flight === 'flying' && !READ_ONLY.has(action))) this.#pilots.set(id, name);
  }

  end(id: string): void {
    const left = (this.#active.get(id) ?? 1) - 1;
    if (left > 0) this.#active.set(id, left);
    else this.#active.delete(id);
  }

  /** Back on the ground with nothing running: anyone may fly it again. Returns true when freed. */
  settle(id: string, flight: 'landed' | 'flying', busy: boolean): boolean {
    if (!this.#pilots.has(id) || flight !== 'landed' || busy || this.#active.has(id)) return false;
    this.#pilots.delete(id);
    return true;
  }

  /** The pilot's name has not been heard from for the timeout (page closed, phone asleep, renamed). */
  absent(id: string): boolean {
    const pilot = this.#pilots.get(id);
    if (!pilot) return false;
    const last = this.#lastSeenByName.get(keyOf(pilot)) ?? -Infinity;
    return this.#now() - last > this.#timeoutMs;
  }
}
