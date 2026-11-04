import assert from 'node:assert/strict';
import test from 'node:test';
import { Pilots, cleanName } from '../src/pilots.ts';

// One laptop, several pages. A fake clock; the pages "poll" by calling seen().
function setup() {
  let now = 0;
  const pilots = new Pilots({ now: () => now, label: (id) => ({ tello: 'Black', rmtt: 'Red' })[id] ?? id });
  const page = (sid, name) => { pilots.seen(sid); if (name) pilots.setName(sid, name); return sid; };
  // A command as the server runs it: check, begin, (the drone works), end, settle.
  const send = (sid, id, action, { flight = 'landed', after = flight, busy = false } = {}) => {
    const refused = pilots.check(sid, id, action);
    if (refused) return refused;
    pilots.begin(sid, id, action, flight);
    pilots.end(id);
    pilots.settle(id, after, busy);
    return null;
  };
  return { pilots, page, send, advance: (ms) => { now += ms; } };
}

test('the person who takes off a drone flies it: nobody else can command it, not even land it', () => {
  const { pilots, page, send } = setup();
  const amir = page('s-amir', 'Amir');
  const marco = page('s-marco', 'Marco');
  assert.equal(send(amir, 'tello', 'takeoff', { after: 'flying' }), null);
  assert.equal(pilots.pilotOf('tello'), 'Amir');
  for (const action of ['move', 'rotate', 'land', 'stop', 'emergency', 'speed', 'scan', 'takeoff']) {
    assert.equal(send(marco, 'tello', action, { flight: 'flying' }), 'Black is flown by Amir. Only Amir can command it until it lands.', action);
  }
  for (const action of ['status', 'look', 'photo']) assert.equal(send(marco, 'tello', action, { flight: 'flying' }), null, action);
  assert.equal(pilots.mayEmergency(marco, 'tello'), false); // Switch off and Cut motors skip it
  assert.equal(pilots.mayEmergency(amir, 'tello'), true);
  assert.equal(send(amir, 'tello', 'move', { flight: 'flying' }), null);
  assert.equal(send(marco, 'rmtt', 'takeoff', { after: 'flying' }), null); // Red is free
  assert.equal(pilots.pilotOf('rmtt'), 'Marco');
});

test('once it has landed and nothing runs, anyone may fly it again', () => {
  const { pilots, page, send } = setup();
  const amir = page('s-amir', 'Amir');
  const marco = page('s-marco', 'Marco');
  send(amir, 'tello', 'takeoff', { after: 'flying' });
  assert.equal(send(amir, 'tello', 'land', { flight: 'flying', after: 'landed' }), null);
  assert.equal(pilots.pilotOf('tello'), null);
  assert.equal(send(marco, 'tello', 'takeoff', { after: 'flying' }), null);
  assert.equal(pilots.pilotOf('tello'), 'Marco');
  // Landed by telemetry (low battery) while busy: freed only when nothing runs any more.
  assert.equal(pilots.settle('tello', 'landed', true), false);
  assert.equal(pilots.settle('tello', 'landed', false), true);
});

test('a takeoff that fails frees the drone; a command still running keeps the lock', () => {
  const { pilots, page, send } = setup();
  const amir = page('s-amir', 'Amir');
  const marco = page('s-marco', 'Marco');
  assert.equal(send(amir, 'tello', 'takeoff', { after: 'landed' }), null); // battery too low: still on the ground
  assert.equal(pilots.pilotOf('tello'), null);
  // While Amir's takeoff waits in the drone's queue, the timer must not free it for Marco.
  pilots.begin(amir, 'tello', 'takeoff', 'landed');
  assert.equal(pilots.settle('tello', 'landed', false), false);
  assert.match(pilots.check(marco, 'tello', 'takeoff'), /flown by Amir/);
  pilots.end('tello');
  assert.equal(pilots.settle('tello', 'landed', false), true);
});

test('the lock goes by the name: the same name on a phone is the pilot, a new name is not', () => {
  const { pilots, page, send } = setup();
  const laptop = page('s-laptop', 'Amir');
  const phone = page('s-phone', '  amir ');
  send(laptop, 'tello', 'takeoff', { after: 'flying' });
  assert.equal(send(phone, 'tello', 'land', { flight: 'flying', after: 'flying' }), null);
  assert.equal(pilots.isPilot(phone, 'tello'), true);
  pilots.setName(laptop, 'Amir B');
  assert.equal(pilots.isPilot(laptop, 'tello'), false);
  assert.match(send(laptop, 'tello', 'land', { flight: 'flying' }), /flown by Amir\. Only Amir/);
});

test('a pilot gone for 15 s (page closed, renamed) is absent; polling keeps the pilot present', () => {
  const { pilots, page, send, advance } = setup();
  const amir = page('s-amir', 'Amir');
  send(amir, 'tello', 'takeoff', { after: 'flying' });
  for (let i = 0; i < 20; i += 1) { advance(1500); pilots.seen(amir); }
  assert.equal(pilots.absent('tello'), false);
  pilots.setName(amir, 'Someone else'); // still polling, but no page uses "Amir" any more
  advance(14_000); pilots.seen(amir);
  assert.equal(pilots.absent('tello'), false);
  advance(1_500); pilots.seen(amir);
  assert.equal(pilots.absent('tello'), true);
  assert.equal(pilots.pilotOf('tello'), 'Amir'); // nobody else takes over: the server lands it
  assert.match(pilots.check(amir, 'tello', 'land'), /flown by Amir/);
  assert.equal(pilots.absent('rmtt'), false);
});

test('taking off needs a name; a drone flying without a pilot is taken by the next command', () => {
  const { pilots, page, send } = setup();
  const nameless = page('s-nobody');
  assert.match(send(nameless, 'tello', 'takeoff'), /Type your name first/);
  assert.equal(send(nameless, 'tello', 'status'), null);
  const amir = page('s-amir', 'Amir');
  // Flying with no pilot (the server restarted mid-flight): Amir's land makes Amir the pilot until it is down.
  pilots.begin(amir, 'tello', 'land', 'flying');
  assert.equal(pilots.pilotOf('tello'), 'Amir');
  pilots.end('tello');
  assert.equal(pilots.settle('tello', 'landed', false), true);
});

test('names are cleaned and compared without case or extra spaces', () => {
  assert.equal(cleanName('  Amélie   Rossi <b>'), 'Amélie Rossi b');
  assert.equal(cleanName('x'.repeat(40)).length, 24);
  assert.equal(cleanName(42), '');
  const { pilots, page } = setup();
  page('a', 'Amir'); page('b', 'AMIR'); page('c', 'Marco');
  assert.deepEqual(pilots.online().sort(), ['AMIR', 'Marco']);
  assert.equal(pilots.setName('d', '<<>>'), '');
});
