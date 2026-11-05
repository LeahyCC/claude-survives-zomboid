import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyStats, loadStats, observe, observeDeath, takeEnded, summary, saveable, MAX_RUNS } from './stats.mjs';

const live = (o = {}) => ({ v: 2, dead: false, hp: 100, hoursAlive: 10, kills: 0, day: 0, z: 0, hunger: 0.2, thirst: 0.2, bleeding: 0, wounds: [], zList: [], ...o });

test('a run tracks hours, kills, day and damage', () => {
  const s = emptyStats();
  assert.equal(observe(s, live({ hoursAlive: 10 }), 1000), true);
  observe(s, live({ hoursAlive: 11, hp: 80, kills: 2, day: 1 }), 2000);
  observe(s, live({ hoursAlive: 12, hp: 90, kills: 3 }), 3000);
  observe(s, live({ hoursAlive: 13, hp: 70, kills: 3 }), 4000);
  const cur = summary(s).current;
  assert.equal(cur.hoursSurvived, 3);
  assert.equal(cur.kills, 3);
  assert.equal(cur.day, 1);
  // 20 lost, 10 healed (not counted), 20 lost.
  assert.equal(cur.damage, 40);
});

test('searched buildings count once each, from done SEARCH results', () => {
  const s = emptyStats();
  const done = (seq, id) => live({ inBldg: { id }, res: { seq, verb: 'SEARCH', status: 'done', why: 'took 3: Hammer' } });
  observe(s, live());
  observe(s, done(5, '4021'));
  observe(s, done(5, '4021'));
  observe(s, done(7, '4021'));
  observe(s, done(9, '4022'));
  assert.equal(summary(s).current.searched, 2);
});

test('death closes the run, guesses the cause and keeps the last 20', () => {
  const s = emptyStats();
  for (let i = 0; i < MAX_RUNS + 3; i++) {
    observe(s, live({ hoursAlive: 1 + i }), i * 10);
    observe(s, live({ hoursAlive: 2 + i, zList: [{ d: 1.5 }], wounds: [{ part: 'Hand_L', bite: true }] }), i * 10 + 1);
    assert.equal(observe(s, { dead: true }, i * 10 + 2), true);
  }
  assert.equal(s.runs.length, MAX_RUNS);
  assert.equal(s.run, null);
  assert.equal(summary(s).runs[0].cause, 'bitten');
});

test('hours going backwards starts a new run', () => {
  const s = emptyStats();
  observe(s, live({ hoursAlive: 50 }));
  observe(s, live({ hoursAlive: 1 }));
  assert.equal(s.runs.length, 1);
  // Nothing in the last seconds fits a cause, so it stays unknown.
  assert.equal(s.runs[0].cause, 'unknown');
  assert.equal(s.run.startHours, 1);
});

test('loadStats survives junk and saveable drops the tail', () => {
  assert.deepEqual(loadStats(null), emptyStats());
  assert.deepEqual(loadStats({ run: 5, runs: 'x' }).runs, []);
  const s = emptyStats();
  observe(s, live());
  assert.deepEqual(Object.keys(saveable(s)).sort(), ['lastDeathId', 'run', 'runs']);
});

// The real runs ended like this: the dead percept never reached the bridge, a new character did.
// The bridge's own last seconds still say something.
test('a new character after a fight still names the cause from the tail', () => {
  const s = emptyStats();
  observe(s, live({ hoursAlive: 40 }), 1000);
  const hit = (hp) => live({ hoursAlive: 40.1, hp, zList: [{ d: 1.2, chase: true }], zChasing: 1, res: { verb: 'SEARCH', status: 'running', seq: 3 } });
  observe(s, hit(80), 2000);
  observe(s, hit(40), 3000);
  observe(s, live({ hoursAlive: 0.1 }), 4000);
  assert.equal(s.runs[0].cause, 'bitten');
  assert.equal(s.runs[0].death.order, 'SEARCH');
  assert.equal(s.runs[0].death.source, 'bridge');
});

const record = (o = {}) => ({
  id: 'k1', hours: 12.5, kills: 6, day: 2,
  ring: [
    { hp: 90, zAdj: 0, zChasing: 2, reflex: 'flee', job: 'GOTO' },
    { hp: 40, zAdj: 2, zChasing: 2, reflex: 'flee', job: 'GOTO' },
  ],
  final: { hp: 0, zAdj: 3, zChasing: 2, reflex: 'flee', job: 'GOTO' },
  text: 'You died.', ...o,
});

test('the dead percept carries the mod record and sets the cause and facts', () => {
  const s = emptyStats();
  observe(s, live({ hoursAlive: 12 }), 1000);
  assert.equal(observe(s, { dead: true, death: record() }, 2000), true);
  const row = summary(s).runs[0];
  assert.equal(row.cause, 'overrun while fleeing');
  assert.equal(row.death.job, 'GOTO');
  assert.equal(row.death.zAdj, 3);
  assert.equal(row.death.hpLost10, 90);
  assert.equal(row.death.source, 'mod');
  assert.match(row.death.summary, /GOTO, 3 close, 2 chasing/);
  assert.equal(row.hoursAlive, 12.5);
  assert.equal(row.kills, 6);
  assert.equal(takeEnded(s).cause, 'overrun while fleeing');
  assert.equal(takeEnded(s), null);
  assert.equal(s.lastDeathId, 'k1');
});

test('the death file ends the live run, and the same record is not applied twice', () => {
  const s = emptyStats();
  observe(s, live({ hoursAlive: 12 }), 1000);
  assert.equal(observeDeath(s, record(), 2000, 2000), true);
  assert.equal(s.run, null);
  assert.equal(s.runs[0].cause, 'overrun while fleeing');
  assert.equal(observeDeath(s, record(), 2500, 2500), false);
  // The dead percept that follows finds no live run.
  assert.equal(observe(s, { dead: true, death: record() }, 3000), false);
  assert.equal(s.runs.length, 1);
});

test('a death record from before the run started belongs to an earlier character', () => {
  const s = emptyStats();
  observe(s, live({ hoursAlive: 3 }), Date.now());
  assert.equal(observeDeath(s, record({ id: 'old', hours: 3.1 }), Date.now() - 3_600_000), false);
  assert.ok(s.run);
  // The hours test: a record that is hours behind the run does not end it either.
  assert.equal(observeDeath(s, record({ id: 'old2', hours: 0.5 }), Date.now() + 1000), false);
  assert.ok(s.run);
});

test('a record that arrives after a thin guess upgrades that run', () => {
  const s = emptyStats();
  observe(s, live({ hoursAlive: 12 }), 1000);
  observe(s, { dead: true }, 2000);
  assert.equal(s.runs[0].cause, 'unknown');
  takeEnded(s);
  assert.equal(observeDeath(s, record(), 5000, 5000), true);
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].cause, 'overrun while fleeing');
  assert.equal(takeEnded(s), s.runs[0]);
});

test('a junk death file changes nothing', () => {
  const s = emptyStats();
  observe(s, live(), 1000);
  assert.equal(observeDeath(s, null, 1, 2), false);
  assert.equal(observeDeath(s, { hours: 4 }, 1, 2), false);
  assert.ok(s.run);
});

test('a live run has no death facts in the summary', () => {
  const s = emptyStats();
  observe(s, live());
  assert.equal(summary(s).current.death, null);
  assert.equal(summary(s).current.cause, 'alive');
});
