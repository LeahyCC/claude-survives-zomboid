import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyStats, loadStats, observe, guessCause, summary, saveable, MAX_RUNS } from './stats.mjs';

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
  assert.equal(s.runs[0].cause, 'unknown');
  assert.equal(s.run.startHours, 1);
});

test('cause of death from the last seconds', () => {
  const g = (o) => ({ hp: 50, z: 0, hunger: 0.2, thirst: 0.2, bleeding: 0, bite: false, nearest: 99, ...o });
  assert.equal(guessCause([g({}), g({ z: -1 })]), 'fell');
  assert.equal(guessCause([g({ thirst: 0.99 })]), 'dehydrated');
  assert.equal(guessCause([g({ hunger: 0.99 })]), 'starved');
  assert.equal(guessCause([g({ nearest: 2, bleeding: 2 })]), 'bitten');
  assert.equal(guessCause([g({ bleeding: 1 })]), 'bled out');
  assert.equal(guessCause([g({})]), 'unknown');
  assert.equal(guessCause([]), 'unknown');
});

test('loadStats survives junk and saveable drops the tail', () => {
  assert.deepEqual(loadStats(null), emptyStats());
  assert.deepEqual(loadStats({ run: 5, runs: 'x' }).runs, []);
  const s = emptyStats();
  observe(s, live());
  assert.deepEqual(Object.keys(saveable(s)).sort(), ['run', 'runs']);
});
