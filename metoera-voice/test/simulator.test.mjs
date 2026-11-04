import assert from 'node:assert/strict';
import test from 'node:test';

import { Simulator } from '../src/simulator.ts';

const command = (droneId, action, details = {}) => ({ droneId, action, ...details });

test('starts with two independent connected simulation drones', () => {
  const simulator = new Simulator();
  const snapshots = simulator.snapshot();

  assert.deepEqual(
    snapshots.map(({ timestamp, ...snapshot }) => snapshot),
    [
      {
        id: 'drone-1',
        connected: true,
        mode: 'simulation',
        position: { x: -1, y: 0, z: 0 },
        heading: 0,
        flight: 'landed',
        motion: 'stationary',
      },
      {
        id: 'drone-2',
        connected: true,
        mode: 'simulation',
        position: { x: 1, y: 0, z: 0 },
        heading: 0,
        flight: 'landed',
        motion: 'stationary',
      },
    ],
  );
  assert.ok(snapshots.every(({ timestamp }) => !Number.isNaN(Date.parse(timestamp))));
});

test('commands affect only their addressed target', async () => {
  const simulator = new Simulator();

  await simulator.execute(command('drone-1', 'takeoff'));
  await simulator.execute(
    command('drone-1', 'move', { direction: 'forward', centimeters: 100 }),
  );

  const [first, second] = simulator.snapshot();
  assert.deepEqual(first.position, { x: -1, y: 1, z: 0.8 });
  assert.equal(first.flight, 'flying');
  assert.deepEqual(second.position, { x: 1, y: 0, z: 0 });
  assert.equal(second.flight, 'landed');
});

test('executes a takeoff, movement, rotation, and landing sequence', async () => {
  const simulator = new Simulator();

  const takeoff = await simulator.execute(command('drone-2', 'takeoff'));
  const up = await simulator.execute(
    command('drone-2', 'move', { direction: 'up', centimeters: 20 }),
  );
  const rotate = await simulator.execute(
    command('drone-2', 'rotate', { direction: 'counterclockwise', degrees: 90 }),
  );
  const land = await simulator.execute(command('drone-2', 'land'));

  assert.equal(takeoff.ok && takeoff.drone.position.z, 0.8);
  assert.equal(up.ok && up.drone.position.z, 1);
  assert.equal(rotate.ok && rotate.drone.heading, 270);
  assert.equal(land.ok && land.drone.flight, 'landed');
  assert.equal(land.ok && land.drone.position.z, 0);
});

test('accepts movement and rotation boundaries', async () => {
  const simulator = new Simulator();
  await simulator.execute(command('drone-1', 'takeoff'));

  const minimumMove = await simulator.execute(
    command('drone-1', 'move', { direction: 'up', centimeters: 20 }),
  );
  const maximumMove = await simulator.execute(
    command('drone-1', 'move', { direction: 'forward', centimeters: 500 }),
  );
  const minimumRotate = await simulator.execute(
    command('drone-1', 'rotate', { direction: 'clockwise', degrees: 1 }),
  );
  const maximumRotate = await simulator.execute(
    command('drone-1', 'rotate', { direction: 'clockwise', degrees: 360 }),
  );

  assert.ok(minimumMove.ok);
  assert.equal(maximumMove.ok && maximumMove.drone.position.y, 5);
  assert.equal(minimumRotate.ok && minimumRotate.drone.heading, 1);
  assert.equal(maximumRotate.ok && maximumRotate.drone.heading, 1);
});

test('moves relative to heading in every horizontal direction', async () => {
  const simulator = new Simulator();
  await simulator.execute(command('drone-1', 'takeoff'));
  await simulator.execute(
    command('drone-1', 'rotate', { direction: 'clockwise', degrees: 90 }),
  );

  await simulator.execute(
    command('drone-1', 'move', { direction: 'forward', centimeters: 100 }),
  );
  await simulator.execute(
    command('drone-1', 'move', { direction: 'right', centimeters: 100 }),
  );
  await simulator.execute(
    command('drone-1', 'move', { direction: 'back', centimeters: 20 }),
  );
  const result = await simulator.execute(
    command('drone-1', 'move', { direction: 'left', centimeters: 20 }),
  );

  assert.ok(result.ok);
  assert.deepEqual(result.drone.position, { x: -0.2, y: -0.8, z: 0.8 });
});

test('rejects malformed and unknown input without throwing or mutating state', async () => {
  const invalidCommands = [
    null,
    [],
    {},
    command('drone-3', 'takeoff'),
    command('drone-1', 'launch'),
    command('drone-1', 'takeoff', { extra: true }),
    command('drone-1', 'move', { direction: 'sideways', centimeters: 20 }),
    command('drone-1', 'move', { direction: 'up', centimeters: 19 }),
    command('drone-1', 'move', { direction: 'up', centimeters: 501 }),
    command('drone-1', 'move', { direction: 'up', centimeters: 20.5 }),
    command('drone-1', 'move', { direction: 'up', centimeters: NaN }),
    command('drone-1', 'rotate', { direction: 'around', degrees: 1 }),
    command('drone-1', 'rotate', { direction: 'clockwise', degrees: 0 }),
    command('drone-1', 'rotate', { direction: 'clockwise', degrees: 361 }),
    command('drone-1', 'rotate', { direction: 'clockwise', degrees: 1.5 }),
  ];

  const simulator = new Simulator();
  for (const invalidCommand of invalidCommands) {
    const result = await simulator.execute(invalidCommand);
    assert.equal(result.ok, false);
    assert.equal(result.mode, 'simulation');
    assert.equal(typeof result.error, 'string');
  }
  assert.deepEqual(
    simulator.snapshot().map(({ position, heading, flight }) => ({ position, heading, flight })),
    [
      { position: { x: -1, y: 0, z: 0 }, heading: 0, flight: 'landed' },
      { position: { x: 1, y: 0, z: 0 }, heading: 0, flight: 'landed' },
    ],
  );
});

test('enforces flight state and prevents negative altitude', async () => {
  const simulator = new Simulator();

  assert.equal((await simulator.execute(command('drone-1', 'land'))).ok, false);
  assert.equal(
    (
      await simulator.execute(
        command('drone-1', 'move', { direction: 'forward', centimeters: 20 }),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await simulator.execute(
        command('drone-1', 'rotate', { direction: 'clockwise', degrees: 1 }),
      )
    ).ok,
    false,
  );

  await simulator.execute(command('drone-1', 'takeoff'));
  assert.equal((await simulator.execute(command('drone-1', 'takeoff'))).ok, false);
  const belowGround = await simulator.execute(
    command('drone-1', 'move', { direction: 'down', centimeters: 100 }),
  );
  assert.equal(belowGround.ok, false);
  assert.equal(simulator.snapshot()[0].position.z, 0.8);
});

test('serializes concurrent commands in submission order', async () => {
  const simulator = new Simulator();

  const results = await Promise.all([
    simulator.execute(command('drone-1', 'takeoff')),
    simulator.execute(
      command('drone-1', 'move', { direction: 'forward', centimeters: 100 }),
    ),
    simulator.execute(command('drone-1', 'land')),
  ]);

  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true, true],
  );
  assert.deepEqual(simulator.snapshot()[0].position, { x: -1, y: 1, z: 0 });
  assert.equal(simulator.snapshot()[0].flight, 'landed');
});
