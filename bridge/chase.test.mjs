// The chase clock: how long the reflex has had a chase to itself, and when the brain gets a turn.
// The soak this is for: one zombie, 33 minutes of "reflex owns it", no order.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createChaseClock, HANDBACK_MS, CHASE_CLEAR_MS, HANDBACK_AGAIN_MS } from './chase.mjs';

const zed = (d, extra = {}) => ({ chase: true, d, dx: d, dy: 0, down: false, crawl: false, ...extra });
// The soak's percept: one chaser 8.4 tiles off, the reflex last on FLEE.
const percept = (o = {}) => ({ v: 2, zList: [zed(8.4)], reflex: { stance: 'FLEE', age: 3, hits60: 0, fails: 1, stuck: false }, ...o });
const SEC = 1000;

// Look once a second for this long, with the hold on.
function watch(clock, p, from, secs) {
  let last = null;
  for (let s = 0; s <= secs; s++) {
    clock.observe(p, from + s * SEC);
    last = clock.due(p, from + s * SEC);
    if (last) return { at: s, due: last };
  }
  return { at: null, due: null };
}

test('a chase the reflex has had for a minute is handed back, not a second sooner', () => {
  const clock = createChaseClock();
  const r = watch(clock, percept(), 1_000_000, 120);
  assert.equal(r.at, HANDBACK_MS / SEC);
  assert.match(r.due.why, /60 seconds/);
  assert.equal(r.due.ms, HANDBACK_MS);
});

test('the reflex saying it is stuck hands back at once', () => {
  const clock = createChaseClock();
  const p = percept({ reflex: { stance: 'FLEE', age: 1, hits60: 0, fails: 3, stuck: true } });
  clock.observe(p, 5_000);
  assert.match(clock.due(p, 5_000).why, /no way out/);
});

test('after a hand-back the next one waits, then comes if the chase is still on', () => {
  const clock = createChaseClock();
  const p = percept();
  const first = watch(clock, p, 0, 120);
  clock.handedBack(first.at * SEC);
  const second = watch(clock, p, first.at * SEC + SEC, 200);
  // The second look began one second after the hand-back.
  assert.equal(second.at + 1, HANDBACK_AGAIN_MS / SEC);
});

test('a gap with the hold off for 15 seconds starts the count again', () => {
  const clock = createChaseClock();
  const on = percept();
  const off = percept({ zList: [zed(14)] });
  for (let s = 0; s < 50; s++) clock.observe(on, s * SEC);
  // The chaser drops out of range for 10 seconds: the same chase.
  for (let s = 50; s < 60; s++) clock.observe(off, s * SEC);
  clock.observe(on, 60 * SEC);
  assert.equal(clock.ownedMs(60 * SEC), 60 * SEC);
  assert.ok(clock.due(on, 60 * SEC));
  // Out of range for 15 seconds or more: a new chase.
  const clock2 = createChaseClock();
  for (let s = 0; s < 50; s++) clock2.observe(on, s * SEC);
  for (let s = 50; s < 50 + CHASE_CLEAR_MS / SEC; s++) clock2.observe(off, s * SEC);
  const back = 50 * SEC + CHASE_CLEAR_MS;
  clock2.observe(on, back);
  assert.equal(clock2.ownedMs(back), 0);
  assert.equal(clock2.due(on, back), null);
});

test('a bridge that was not looking for a while does not count the gap as chase time', () => {
  const clock = createChaseClock();
  const p = percept();
  clock.observe(p, 0);
  clock.observe(p, 10 * 60 * SEC);
  assert.equal(clock.ownedMs(10 * 60 * SEC), 0);
  assert.equal(clock.due(p, 10 * 60 * SEC), null);
});

test('no hold, no hand-back', () => {
  const clock = createChaseClock();
  const calm = percept({ zList: [zed(14)] });
  assert.equal(watch(clock, calm, 0, 200).due, null);
  const stuck = percept({ zList: [], reflex: { stuck: true } });
  clock.observe(stuck, 0);
  assert.equal(clock.due(stuck, 0), null, 'a stuck flag with nothing near is stale');
});

test('a big chase, damage or a working fight is left to the reflex', () => {
  const three = percept({ zList: [zed(5), zed(6, { dy: 2 }), zed(7, { dy: -2 })] });
  assert.equal(watch(createChaseClock(), three, 0, 200).due, null, 'a pack is the reflex\'s');
  const hurt = percept({ reflex: { stance: 'FLEE', age: 2, hits60: 1 } });
  assert.equal(watch(createChaseClock(), hurt, 0, 200).due, null, 'being hit is not "stuck"');
  const fighting = percept({ reflex: { stance: 'FIGHT', age: 4, hits60: 0 } });
  assert.equal(watch(createChaseClock(), fighting, 0, 200).due, null, 'a fight that is on stays on');
  const oldFight = percept({ reflex: { stance: 'FIGHT', age: 90, hits60: 0 } });
  assert.ok(watch(createChaseClock(), oldFight, 0, 200).due, 'a fight 90 seconds ago is not now');
  const down = percept({ zList: [zed(5), zed(6, { down: true }), zed(7, { down: true }), zed(8, { crawl: true })] });
  assert.ok(watch(createChaseClock(), down, 0, 200).due, 'downed ones do not make a pack');
});

test('a zombie she can see inside 3 that is not chasing holds the brain off too, and counts', () => {
  const p = percept({ zList: [zed(2.5, { chase: false })], zVisible: 1, reflex: { stance: 'NONE', age: -1, hits60: 0 } });
  const r = watch(createChaseClock(), p, 0, 120);
  assert.equal(r.at, HANDBACK_MS / SEC);
});
