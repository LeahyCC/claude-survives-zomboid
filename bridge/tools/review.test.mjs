import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport, groupMissing, failures, harmful, deathsByCause, reflexByStance, main } from './review.mjs';
import { joinRecords } from '../decisions.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));

const decision = (id, at, o = {}) => ({
  t: 'decision', id, at, run: 'r', by: 'model', rule: null, choice: 'b1', verb: 'ENTER', key: 'ENTER:7', sent: true, seq: 1, menu: [], ...o,
});
const outcome = (id, result, why = '', lostDuring = 0) => ({ t: 'outcome', id, at: '2026-11-04T10:00:30Z', verb: 'ENTER', result, why, ms: 3000, hpDuring: -lostDuring, lostDuring });
const after = (id, o = {}) => ({ t: 'after', id, at: '2026-11-04T10:06:00Z', hpAfter: 0, lostAfter: 0, chased: false, died: false, ...o });

const DECISIONS = [
  decision('d1', '2026-11-04T10:00:00Z'), outcome('d1', 'failed', 'stuck'), after('d1'),
  decision('d2', '2026-11-04T10:01:00Z'), outcome('d2', 'failed', 'stuck'), after('d2'),
  decision('d3', '2026-11-04T10:02:00Z'), outcome('d3', 'done', 'in by a door', 3), after('d3', { lostAfter: 12, chased: true }),
  decision('d4', '2026-11-05T09:00:00Z', { by: 'policy', rule: 'night-outside', verb: 'GOTO', key: 'GOTO:1' }), outcome('d4', 'done'), after('d4', { died: true }),
  decision('d5', '2026-11-05T09:05:00Z', { by: 'policy', rule: 'thirst', verb: 'DRINK', key: 'DRINK' }), outcome('d5', 'done'), after('d5'),
  decision('d6', '2026-11-05T09:06:00Z', { sent: false, verb: null, choice: 'keep' }),
];

const nudge = (at, o = {}) => ({
  t: 'nudge', at, mode: 'log', pick: 'away', pickKey: 'AWAY', missing: '', why: '', situation: 'outside, day, not chased, no urgent need',
  brain: { id: 'b1', key: 'ENTER:7' }, ...o,
});
const NUDGES = [
  nudge('2026-11-04T10:00:00Z'),
  nudge('2026-11-04T10:01:00Z', { pick: 'b1', pickKey: 'ENTER:7' }),
  nudge('2026-11-05T09:00:00Z', { situation: 'inside, night, not chased, tired', pick: 'sleep', pickKey: 'SLEEP', brain: { id: 'wait', key: 'WAIT' } }),
  nudge('2026-11-04T10:02:00Z', { pick: null, pickKey: null, pickVerb: null, missing: 'climb over the low fence' }),
  nudge('2026-11-05T09:01:00Z', { pick: null, pickKey: null, missing: 'Climb the fence over the low wall', situation: 'inside, night, not chased, tired' }),
  nudge('2026-11-05T09:02:00Z', { pick: null, pickKey: null, missing: 'pick the lock' }),
];

test('the report counts agreement overall and by situation', () => {
  const text = buildReport({ decisions: DECISIONS, nudges: NUDGES });
  // away vs b1 (no), b1 vs b1 (yes), sleep vs wait (no).
  assert.match(text, /Overall: the brain had your pick 1 of 3 times \(33%\)/);
  assert.match(text, /outside, day, not chased, no urgent need: 1 of 2 \(50%\)/);
  assert.match(text, /inside, night, not chased, tired: 0 of 1 \(0%\)/);
  assert.match(text, /6 nudges, 3 with a pick, 3 saying an option is missing/);
});

test('missing-option notes that say the same thing are grouped', () => {
  const groups = groupMissing(NUDGES);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].texts.length, 2);
  assert.equal(groups[0].situations.size, 2);
  const text = buildReport({ decisions: DECISIONS, nudges: NUDGES });
  assert.match(text, /2x "climb over the low fence" \(and 1 like it\)/);
  assert.match(text, /1x "pick the lock"/);
});

test('the failing orders are listed by verb with their reasons', () => {
  const rows = failures(joinRecords(DECISIONS));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verb, 'ENTER');
  assert.equal(rows[0].failed, 2);
  assert.equal(rows[0].total, 3);
  assert.match(buildReport({ decisions: DECISIONS, nudges: [] }), /ENTER: 2 of 3 failed \(67%\): stuck 2/);
});

test('choices followed by damage or death are listed, deaths first', () => {
  const rows = harmful(joinRecords(DECISIONS));
  assert.deepEqual(rows.map((r) => r.key), ['GOTO by policy (night-outside)', 'ENTER by model']);
  assert.equal(rows[0].died, 1);
  assert.equal(rows[1].damaged, 1);
  assert.equal(rows[1].chased, 1);
  const text = buildReport({ decisions: DECISIONS, nudges: [] });
  assert.match(text, /GOTO by policy \(night-outside\): 0 damaged and 1 died of 1/);
  assert.match(text, /ENTER by model: 1 damaged and 0 died of 3, a zombie started chasing 1x/);
  assert.doesNotMatch(text, /DRINK/);
});

test('--since keeps only lines from that date on', () => {
  const text = buildReport({ decisions: DECISIONS, nudges: NUDGES, from: new Date('2026-11-05') });
  assert.match(text, /Review since 2026-11-05/);
  assert.match(text, /3 decisions \(policy 2, model 1, nudge 0\)/);
  assert.match(text, /3 nudges, 1 with a pick, 2 saying an option is missing/);
  assert.match(text, /Overall: the brain had your pick 0 of 1/);
  assert.match(text, /No failed orders/);
});

test('an empty log gives a report, not a crash', () => {
  const text = buildReport({});
  assert.match(text, /0 decisions/);
  assert.match(text, /No nudges with a pick yet/);
  assert.match(text, /None noted/);
});

test('the command reads both files, takes --since, and rejects a bad date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-review-'));
  try {
    const d = path.join(dir, 'decisions.jsonl');
    const n = path.join(dir, 'nudges.jsonl');
    fs.writeFileSync(d, DECISIONS.map((l) => JSON.stringify(l)).join('\n') + '\ngarbage\n');
    fs.writeFileSync(n, NUDGES.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const ok = spawnSync(process.execPath, [REVIEW, '--decisions', d, '--nudges', n, '--since', '2026-11-05'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Review since 2026-11-05/);
    assert.match(ok.stdout, /Overall: the brain had your pick 0 of 1/);
    const bad = spawnSync(process.execPath, [REVIEW, '--decisions', d, '--nudges', n, '--since', 'someday'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--since needs a date/);
    assert.equal(main(['--decisions', d, '--nudges', n, '--since']), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const death = (run, cause, o = {}) => ({
  t: 'death', id: `death-${run}`, at: '2026-11-05T09:10:00Z', run, cause, job: 'SEARCH', zClose: 2, zChasing: 3, hpLost10: 40, source: 'mod', ...o,
});

test('deaths are grouped by cause, most common first, with the job and the averages', () => {
  const groups = deathsByCause([
    death('r1', 'bitten while busy'), death('r2', 'bitten while busy', { job: 'GOTO', zClose: 1, hpLost10: 20 }),
    death('r3', 'starved', { job: null, order: null, zClose: 0, zChasing: 0, hpLost10: 0 }),
    { t: 'decision', id: 'x' },
  ]);
  assert.deepEqual(groups.map((g) => [g.cause, g.n]), [['bitten while busy', 2], ['starved', 1]]);
  assert.equal(groups[0].jobs.get('SEARCH'), 1);
  assert.equal(groups[0].hp, 60);
});

test('a run with two death lines counts once, with the newer line', () => {
  const groups = deathsByCause([death('r1', 'unknown', { source: 'bridge' }), death('r1', 'bitten', { job: 'ENTER' })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].cause, 'bitten');
});

test('the report prints deaths by cause, and says so when there are none', () => {
  const text = buildReport({ decisions: [death('r1', 'overrun while fleeing'), death('r2', 'overrun while fleeing', { source: 'bridge' })], nudges: [] });
  assert.ok(text.includes("Deaths by cause\n  2x overrun while fleeing: doing SEARCH 2; 2 close and 3 chasing at the end, 40 hp lost in the last 10 s (1 from the bridge's own guess)"), text);
  assert.ok(buildReport({ decisions: [], nudges: [] }).includes('Deaths by cause\n  No deaths logged.'));
  const since = buildReport({ decisions: [death('r1', 'fell')], nudges: [], from: new Date('2026-11-06') });
  assert.match(since, /No deaths logged/);
});

const reflex = (kind, stance, o = {}) => ({ t: 'reflex', kind, stance, at: '2026-11-05T09:10:00Z', id: o.id || 's-1', ...o });
const REFLEX = [
  reflex('call', 'BREAK', { id: 's-1', why: 'pack' }), reflex('out', 'BREAK', { id: 's-1', escaped: true, chased: false, hits: 0, hpLost: 0, kills: 0 }),
  reflex('call', 'BREAK', { id: 's-2', why: 'pack' }), reflex('out', 'BREAK', { id: 's-2', escaped: false, chased: true, hits: 2, hpLost: 9.5, kills: 0 }),
  reflex('call', 'BREAK', { id: 's-3', why: 'hurt' }),
  reflex('call', 'FIGHT', { id: 's-4', why: '' }), reflex('out', 'FIGHT', { id: 's-4', escaped: false, chased: true, hits: 1, hpLost: 3, kills: 1 }),
];

test('reflex lines are counted by stance: calls, escapes, hits, hp lost and kills', () => {
  const rows = reflexByStance([...REFLEX, decision('d9', '2026-11-05T09:00:00Z')]);
  assert.deepEqual(rows.map((r) => r.stance), ['BREAK', 'FIGHT']);
  const b = rows[0];
  assert.deepEqual({ calls: b.calls, outs: b.outs, escaped: b.escaped, chased: b.chased, hits: b.hits, hpLost: b.hpLost, kills: b.kills },
    { calls: 3, outs: 2, escaped: 1, chased: 1, hits: 2, hpLost: 9.5, kills: 0 });
  assert.deepEqual([...b.why], [['pack', 2], ['hurt', 1]]);
  assert.equal(rows[1].kills, 1);
});

test('the report prints the reflex by stance, and says so when there is none', () => {
  const text = buildReport({ decisions: REFLEX, nudges: [] });
  assert.ok(text.includes('  BREAK: 3 calls (pack 2, hurt 1); escaped 1 of 2 (50%), 2 hits, 10 hp lost, 0 kills'), text);
  assert.ok(text.includes('  FIGHT: 1 calls (- 1); escaped 0 of 1 (0%), 1 hits, 3 hp lost, 1 kills'), text);
  assert.match(buildReport({}), /No reflex lines logged/);
  assert.match(buildReport({ decisions: REFLEX, nudges: [], from: new Date('2026-11-06') }), /No reflex lines logged/);
});
