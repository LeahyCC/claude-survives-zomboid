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
    const { percept, memory, plan: dayPlan } = buildScenario(s);
    const plan = planTurn(percept, memory, { now: 1_000_000, plan: dayPlan });
    assert.ok(['ask', 'policy'].includes(plan.kind), `plan kind is ${plan.kind}`);
  });
}
