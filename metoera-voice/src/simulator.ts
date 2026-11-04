export type DroneSnapshot = {
  id: 'drone-1' | 'drone-2';
  connected: true;
  mode: 'simulation';
  position: {
    x: number;
    y: number;
    z: number;
  };
  heading: number;
  flight: 'landed' | 'flying';
  motion: 'stationary';
  timestamp: string;
};

export type Command =
  | { droneId: 'drone-1' | 'drone-2'; action: 'takeoff' }
  | { droneId: 'drone-1' | 'drone-2'; action: 'land' }
  | {
      droneId: 'drone-1' | 'drone-2';
      action: 'move';
      direction: 'forward' | 'back' | 'left' | 'right' | 'up' | 'down';
      centimeters: number;
    }
  | {
      droneId: 'drone-1' | 'drone-2';
      action: 'rotate';
      direction: 'clockwise' | 'counterclockwise';
      degrees: number;
    };

export type CommandResult =
  | {
      ok: true;
      mode: 'simulation';
      action: Command['action'];
      drone: DroneSnapshot;
    }
  | {
      ok: false;
      mode: 'simulation';
      error: string;
    };

type DroneState = {
  id: 'drone-1' | 'drone-2';
  position: { x: number; y: number; z: number };
  heading: number;
  flight: 'landed' | 'flying';
};

const droneIds = ['drone-1', 'drone-2'] as const;
const moveDirections = ['forward', 'back', 'left', 'right', 'up', 'down'] as const;
const rotateDirections = ['clockwise', 'counterclockwise'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function rounded(value: number): number {
  const result = Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
  return Object.is(result, -0) ? 0 : result;
}

function failure(error: string): CommandResult {
  return { ok: false, mode: 'simulation', error };
}

export class Simulator {
  readonly #drones = new Map<DroneState['id'], DroneState>([
    [
      'drone-1',
      { id: 'drone-1', position: { x: -1, y: 0, z: 0 }, heading: 0, flight: 'landed' },
    ],
    [
      'drone-2',
      { id: 'drone-2', position: { x: 1, y: 0, z: 0 }, heading: 0, flight: 'landed' },
    ],
  ]);

  #queue: Promise<void> = Promise.resolve();

  snapshot(): DroneSnapshot[] {
    return droneIds.map((id) => this.#snapshot(this.#drones.get(id)!));
  }

  async execute(command: unknown): Promise<CommandResult> {
    const operation = this.#queue.then(() => this.#execute(command));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  #execute(value: unknown): CommandResult {
    if (!isRecord(value)) {
      return failure('Command must be an object');
    }

    if (!includes(droneIds, value.droneId)) {
      return failure('Invalid droneId');
    }

    const drone = this.#drones.get(value.droneId)!;

    if (value.action === 'takeoff' || value.action === 'land') {
      if (!hasOnlyKeys(value, ['droneId', 'action'])) {
        return failure(`Unknown argument for ${value.action}`);
      }
      return value.action === 'takeoff' ? this.#takeoff(drone) : this.#land(drone);
    }

    if (value.action === 'move') {
      if (!hasOnlyKeys(value, ['droneId', 'action', 'direction', 'centimeters'])) {
        return failure('Unknown argument for move');
      }
      if (!includes(moveDirections, value.direction)) {
        return failure('Invalid move direction');
      }
      if (!isIntegerInRange(value.centimeters, 20, 500)) {
        return failure('centimeters must be an integer from 20 to 500');
      }
      return this.#move(drone, value.direction, value.centimeters);
    }

    if (value.action === 'rotate') {
      if (!hasOnlyKeys(value, ['droneId', 'action', 'direction', 'degrees'])) {
        return failure('Unknown argument for rotate');
      }
      if (!includes(rotateDirections, value.direction)) {
        return failure('Invalid rotate direction');
      }
      if (!isIntegerInRange(value.degrees, 1, 360)) {
        return failure('degrees must be an integer from 1 to 360');
      }
      return this.#rotate(drone, value.direction, value.degrees);
    }

    return failure('Invalid action');
  }

  #takeoff(drone: DroneState): CommandResult {
    if (drone.flight !== 'landed') {
      return failure('takeoff requires a landed drone');
    }
    drone.position.z = 0.8;
    drone.flight = 'flying';
    return this.#success('takeoff', drone);
  }

  #land(drone: DroneState): CommandResult {
    if (drone.flight !== 'flying') {
      return failure('land requires a flying drone');
    }
    drone.position.z = 0;
    drone.flight = 'landed';
    return this.#success('land', drone);
  }

  #move(
    drone: DroneState,
    direction: Extract<Command, { action: 'move' }>['direction'],
    centimeters: number,
  ): CommandResult {
    if (drone.flight !== 'flying') {
      return failure('move requires a flying drone');
    }

    const meters = centimeters / 100;
    if (direction === 'down' && drone.position.z - meters < 0) {
      return failure('move would result in negative altitude');
    }

    const radians = (drone.heading * Math.PI) / 180;
    const forwardX = Math.sin(radians) * meters;
    const forwardY = Math.cos(radians) * meters;
    const rightX = Math.cos(radians) * meters;
    const rightY = -Math.sin(radians) * meters;

    if (direction === 'forward') {
      drone.position.x = rounded(drone.position.x + forwardX);
      drone.position.y = rounded(drone.position.y + forwardY);
    } else if (direction === 'back') {
      drone.position.x = rounded(drone.position.x - forwardX);
      drone.position.y = rounded(drone.position.y - forwardY);
    } else if (direction === 'right') {
      drone.position.x = rounded(drone.position.x + rightX);
      drone.position.y = rounded(drone.position.y + rightY);
    } else if (direction === 'left') {
      drone.position.x = rounded(drone.position.x - rightX);
      drone.position.y = rounded(drone.position.y - rightY);
    } else if (direction === 'up') {
      drone.position.z = rounded(drone.position.z + meters);
    } else {
      drone.position.z = rounded(drone.position.z - meters);
    }

    return this.#success('move', drone);
  }

  #rotate(
    drone: DroneState,
    direction: Extract<Command, { action: 'rotate' }>['direction'],
    degrees: number,
  ): CommandResult {
    if (drone.flight !== 'flying') {
      return failure('rotate requires a flying drone');
    }
    const signedDegrees = direction === 'clockwise' ? degrees : -degrees;
    drone.heading = (drone.heading + signedDegrees + 360) % 360;
    return this.#success('rotate', drone);
  }

  #success(action: Command['action'], drone: DroneState): CommandResult {
    return { ok: true, mode: 'simulation', action, drone: this.#snapshot(drone) };
  }

  #snapshot(drone: DroneState): DroneSnapshot {
    return {
      id: drone.id,
      connected: true,
      mode: 'simulation',
      position: { ...drone.position },
      heading: drone.heading,
      flight: drone.flight,
      motion: 'stationary',
      timestamp: new Date().toISOString(),
    };
  }
}
