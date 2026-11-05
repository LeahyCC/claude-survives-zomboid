import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toScenarios, patchFor, main } from './nudges-to-eval.mjs';
import { readLog } from '../jsonl.mjs';
import { buildScenario, readBase } from '../eval/scenarios.mjs';
import { buildOptions } from '../options.mjs';
import { planTurn } from '../brain.mjs';

// Three nudges: a pick (away), a missing-option note, and the same pick again a minute later.
const FIXTURE = fileURLToPath(new URL('../fixtures/nudges-example.jsonl', import.meta.url));
const nudges = readLog(FIXTURE, { rotated: false });

test('the example fixture has the three lines the tests rely on', () => {
  assert.equal(nudges.length, 3);
  assert.deepEqual(nudges.map((n) => n.pick), ['away', null, 'away']);
});

test('a nudge with a pick becomes a scenario that accepts his pick', () => {
  const { made } = toScenarios(nudges);
  assert.equal(made.length, 1);
  const { file, scenario: s } = made[0];
  assert.equal(file, 'nudge-2026-11-04-1.json');
  assert.equal(s.name, 'nudge-2026-11-04-1');
  assert.deepEqual(s.accept, ['away']);
  assert.equal(s.from, nudges[0].at);
  assert.match(s.note, /He picked away\. The brain picked b1\. He said: The zombie is too close/);
  // The same checks scenarios.test.mjs makes of every scenario.
  const { percept, memory, plan } = buildScenario(s);
  const ids = buildOptions(percept, memory, { now: 1_000_000, plan }).map((o) => o.id);
  assert.ok(ids.includes('away'));
  assert.ok(['ask', 'policy'].includes(planTurn(percept, memory, { now: 1_000_000, plan }).kind));
});

test('the patch holds only what differs from the base percept', () => {
  const base = readBase();
  const p = { ...base, hp: 40, moodle: { ...base.moodle, panic: 2 } };
  assert.deepEqual(Object.keys(patchFor(p, base)).sort(), ['hp', 'moodle']);
  const { weapon, ...without } = base;
  assert.equal(patchFor(without, base).weapon, null);
});

test('the missing-option note and the repeat are skipped, with a reason', () => {
  const { skipped } = toScenarios(nudges);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].why, /missing-option/);
  assert.match(skipped[1].why, /same as nudge-2026-11-04-1/);
});

test('running it again skips what was already exported', () => {
  const first = toScenarios(nudges);
  const again = toScenarios(nudges, first.made.map((m) => ({ file: m.file, ...m.scenario })));
  assert.equal(again.made.length, 0);
  assert.match(again.skipped[0].why, /already exported/);
});

test('a nudge whose pick is not on the rebuilt menu, or whose moment is not a choice, is skipped', () => {
  const gone = { ...nudges[0], at: '2026-11-04T11:00:00.000Z', pickKey: 'ENTER:99999', pick: 'b9' };
  assert.match(toScenarios([gone]).skipped[0].why, /not on the menu/);
  // A chaser inside 10 tiles: the reflex owns it, so there is no choice to grade.
  const chased = { ...nudges[0], at: '2026-11-04T11:01:00.000Z', percept: { ...nudges[0].percept, zChasing: 1, zList: [{ dx: 4, dy: 0, d: 4, chase: true }] } };
  assert.match(toScenarios([chased]).skipped[0].why, /not on the menu|"hold"/);
  assert.equal(toScenarios([{ t: 'nudge' }, null, 'x']).made.length, 0);
});

test('names count nudges per day and never overwrite a file that is there', () => {
  const second = { ...nudges[0], at: '2026-11-05T08:00:00.000Z', percept: { ...nudges[0].percept, hour: 9 } };
  const taken = [{ file: 'nudge-2026-11-05-1.json', name: 'nudge-2026-11-05-1', patch: {}, accept: ['x'] }];
  const { made } = toScenarios([second], taken);
  assert.equal(made[0].file, 'nudge-2026-11-05-2.json');
});

test('the command writes the files, and --dry writes none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-export-'));
  const log = console.log;
  console.log = () => {};
  try {
    const out = path.join(dir, 'scenarios');
    main(['--nudges', FIXTURE, '--out', out, '--dry']);
    assert.equal(fs.existsSync(out), false);
    main(['--nudges', FIXTURE, '--out', out]);
    assert.deepEqual(fs.readdirSync(out), ['nudge-2026-11-04-1.json']);
    const written = JSON.parse(fs.readFileSync(path.join(out, 'nudge-2026-11-04-1.json'), 'utf8'));
    assert.deepEqual(written.accept, ['away']);
    main(['--nudges', FIXTURE, '--out', out]);
    assert.equal(fs.readdirSync(out).length, 1, 'a second run adds nothing');
  } finally {
    console.log = log;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
