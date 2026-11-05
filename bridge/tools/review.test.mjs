import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport, groupMissing, failures, harmful, deathsByCause, reflexByStance, criticReview, main } from './review.mjs';
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

// A critic line for a decision. p is the probability Jev gave the brain's pick.
const critic = (id, p, o = {}) => ({
  t: 'critic', id, at: '2026-11-05T09:00:05Z', pick: 'b1', top: p < 0.15 ? 'away' : 'b1', pPick: p, pTop: 0.9, confidence: 0.8,
  danger: 0.2, treat: 0.1, mistake: 0.1, agree: p >= 0.15, flag: p < 0.15, flagAt: 0.15, ms: 110, inTokens: 468, outTokens: 12, ...o,
});
const cp = (o = {}) => ({ hour: 12, inside: false, needs: [], z: { chasing: 0 }, ...o });

// Two flagged decisions that went badly, three calm ones that went well, one with no critic line.
const WITH_CRITIC = [
  decision('c1', '2026-11-05T09:00:00Z', { percept: cp() }), outcome('c1', 'failed', 'zombie', 8), after('c1', { lostAfter: 4, chased: true }), critic('c1', 0.05),
  decision('c2', '2026-11-05T09:01:00Z', { percept: cp() }), outcome('c2', 'failed', 'stuck'), after('c2', { died: true }), critic('c2', 0.1),
  decision('c3', '2026-11-05T09:02:00Z', { percept: cp() }), outcome('c3', 'done'), after('c3'), critic('c3', 0.7),
  decision('c4', '2026-11-05T09:03:00Z', { percept: cp({ inside: true, hour: 23, needs: ['tired'] }), by: 'policy', rule: 'sleep' }), outcome('c4', 'done'), after('c4'), critic('c4', 0.4),
  decision('c5', '2026-11-05T09:04:00Z', { percept: cp() }), outcome('c5', 'done'), after('c5'), critic('c5', 0.9),
  decision('c6', '2026-11-05T09:05:00Z', { percept: cp() }), outcome('c6', 'done'), after('c6'),
];

test('the critic section: how often Jev agreed, flags by situation and by who decided', () => {
  const text = buildReport({ decisions: WITH_CRITIC, nudges: [] });
  assert.match(text, /Critic \(Jev's second opinion, logged only, it never steers her\)/);
  assert.match(text, /5 of 6 decisions were reviewed\. Jev's top pick matched the brain's 3 times \(60%\)\./);
  assert.match(text, /Flagged \(the brain's pick got under 15% of Jev's probability\): 2 \(40%\)\./);
  assert.match(text, /outside, day, not chased, no urgent need: 2 of 4 \(50%\)/);
  assert.match(text, /inside, night, not chased, tired: 0 of 1 \(0%\)/);
  assert.match(text, /model: 2 of 4 \(50%\)/);
  assert.match(text, /policy \(sleep\): 0 of 1 \(0%\)/);
});

test('the critic section sets the outcomes after a flag beside those after no flag', () => {
  const c = criticReview(joinRecords(WITH_CRITIC));
  assert.deepEqual(c.afterFlagged, { orders: 2, reported: 2, failed: 2, followed: 2, damaged: 1, chased: 1, died: 1 });
  assert.deepEqual(c.afterCalm, { orders: 3, reported: 3, failed: 0, followed: 3, damaged: 0, chased: 0, died: 0 });
  const text = buildReport({ decisions: WITH_CRITIC, nudges: [] });
  assert.ok(text.includes('    flagged:   2 orders; failed 2 of 2 (100%); lost 5 hp or more 1 of 2 (50%); a zombie started chasing 1 of 2 (50%); died within 5 min 1 of 2 (50%)'), text);
  assert.ok(text.includes('    unflagged: 3 orders; failed 0 of 3 (0%); lost 5 hp or more 0 of 3 (0%); a zombie started chasing 0 of 3 (0%); died within 5 min 0 of 3 (0%)'), text);
});

test('a decision still waiting on its result counts as an order but not as a failure or a death yet', () => {
  const waiting = [decision('w1', '2026-11-05T09:00:00Z', { percept: cp() }), critic('w1', 0.01)];
  assert.deepEqual(criticReview(joinRecords(waiting)).afterFlagged, { orders: 1, reported: 0, failed: 0, followed: 0, damaged: 0, chased: 0, died: 0 });
  assert.match(buildReport({ decisions: waiting, nudges: [] }), /failed 0 of 0 \(n\/a\)/);
});

test('no critic lines: the section says how to turn it on, and the rest of the report is unchanged', () => {
  const text = buildReport({ decisions: DECISIONS, nudges: NUDGES });
  assert.match(text, /No critic lines\. Set TYPESAFE_API_KEY to turn it on/);
  assert.match(text, /Overall: the brain had your pick 1 of 3 times/);
  assert.match(buildReport({}), /No critic lines/);
});

test('--since applies to the critic section too, and a critic line with no decision is ignored', () => {
  const lines = [...WITH_CRITIC, critic('orphan', 0.01)];
  assert.match(buildReport({ decisions: lines, nudges: [], from: new Date('2026-11-06') }), /No critic lines/);
  assert.match(buildReport({ decisions: lines, nudges: [] }), /5 of 6 decisions were reviewed/);
});

test('the command prints the critic section from a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-review-critic-'));
  try {
    const d = path.join(dir, 'decisions.jsonl');
    fs.writeFileSync(d, WITH_CRITIC.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const run = spawnSync(process.execPath, [REVIEW, '--decisions', d, '--nudges', path.join(dir, 'none.jsonl')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /5 of 6 decisions were reviewed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
