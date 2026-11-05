import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios, buildScenario } from './scenarios.mjs';
import { planTurn } from '../brain.mjs';
import { buildOptions } from '../options.mjs';
import { isV2 } from '../senses.mjs';

const scenarios = loadScenarios();

test('there are at least 20 scenarios with unique names', () => {
  assert.ok(scenarios.length >= 20, `only ${scenarios.length}`);
  assert.equal(new Set(scenarios.map((s) => s.name)).size, scenarios.length);
});

for (const s of scenarios) {
  test(`scenario ${s.name} is valid and its accepted ids are on the menu`, () => {
    assert.equal(s.file, `${s.name}.json`, 'file name matches name');
    assert.ok(s.note, 'has a note');
    assert.ok(Array.isArray(s.accept) && s.accept.length, 'has accepted ids');
    const { percept, memory, plan } = buildScenario(s);
    assert.ok(isV2(percept));
    const ids = buildOptions(percept, memory, { now: 1_000_000, plan }).map((o) => o.id);
    for (const id of s.accept) assert.ok(ids.includes(id), `${id} is not in [${ids}]`);
    for (const id of s.wrong || []) assert.ok(!s.accept.includes(id), `${id} is both accepted and wrong`);
  });

  test(`scenario ${s.name} reaches a decision`, () => {
    const { percept, memory, plan: dayPlan, history } = buildScenario(s);
    const plan = planTurn(percept, memory, { now: 1_000_000, plan: dayPlan, history });
    assert.ok(['ask', 'policy'].includes(plan.kind), `plan kind is ${plan.kind}`);
  });
}

test('a scenario can seed failed orders and recent history', () => {
  const s = {
    name: 'x', patch: {}, memory: { fails: { 'ENTER:4060': { why: 'locked', ago: 120 } } },
    history: [{ verb: 'ENTER', key: 'ENTER:4060', name: 'ENTER house N', result: 'failed', why: 'locked', ago: 125 }],
  };
  const { memory, history } = buildScenario(s, 1_000_000);
  assert.deepEqual(memory.fails['ENTER:4060'], { why: 'locked', at: 880_000 });
  assert.equal(history.length, 1);
  assert.equal(history[0].at, 875_000);
  assert.equal(history[0].result, 'failed');
  assert.deepEqual(buildScenario({ name: 'y', patch: {} }).history, []);
});

test('the scenarios that depend on a recent outcome put it in the prompt', () => {
  for (const name of ['retry-failed-house', 'flee-loop-quieter-house', 'two-houses-failed-pick-third']) {
    const s = scenarios.find((x) => x.name === name);
    const { percept, memory, history } = buildScenario(s);
    const plan = planTurn(percept, memory, { now: 1_000_000, history });
    assert.equal(plan.kind, 'ask', name);
    assert.match(plan.user, /RECENT CHOICES:[\s\S]*failed, zombies at the door/, name);
  }
});
