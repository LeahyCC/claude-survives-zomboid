// Time the inner voice against the real models (docs/brain.md, Inner voice).
//
//   node bridge/tools/try-pepe.mjs [--n 5]
//
// 1. A short scripted run played through the real commentator: orders paired with the brain's thought,
//    a few moments, one idle thought. Each line carries the running summary and the last 4 lines, so
//    the times are for the longer prompt. The first one is apart (it carries the model load).
// 2. A menu turn alone, then a menu turn fired while a thought is being written. The thought must be
//    cut at once and the turn must stay as fast as it was alone.
import { loadFixture } from '../fixtures/load.mjs';
import { planTurn } from '../brain.mjs';
import { callChoice, parseChoice, callCommentary, commentBusy, PEPE_MODEL, MODEL } from '../llm.mjs';
import { SYSTEM, createCommentator, MIN_GAP_MS, IDLE_MIN_MS } from '../commentator.mjs';

const args = process.argv.slice(2);
const nIndex = args.indexOf('--n');
const reps = nIndex >= 0 ? Math.max(1, Number(args[nIndex + 1]) || 5) : 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { percept, memory } = loadFixture('v2-night-outside.json');
const plan = planTurn(percept, memory, { now: 1_000_000 });
const ids = plan.options.map((o) => o.id);

// Same prompt the bridge sends, with a fake clock so the 30 s gap does not slow the script.
const clock = { t: 1_000_000 };
const sent = [];
const times = [];
const c = createCommentator({
  ask: async (req) => { sent.push(req); const r = await callCommentary(req); times.push(r.ms); return r; },
  now: () => clock.t,
  rand: () => 0,
  write: (o) => {
    const pair = o.action ? `${o.action} "${o.thought}" => ` : '';
    console.log(`${times.length === 1 ? 'first (load)' : 'line'} ${o.ms} ms [${o.kind}] ${pair}${o.line}`);
    return true;
  },
});
const mk = (extra) => ({ v: 2, dead: false, hp: 100, kills: 0, hoursAlive: 5, day: 1, hour: 9, bleeding: 0, weapon: 'none', zChasing: 0, zClose: 0, inBldg: null, outside: true, ...extra });
const step = async (fn) => { clock.t += MIN_GAP_MS + 1000; await fn(); };
console.log(`# comment model ${PEPE_MODEL}, menu model ${MODEL}`);
c.observe(mk(), { run: 'r1', searched: 0 });
await step(() => c.order({ action: 'ENTER house W', thought: 'I need to hide out before dark' }));
await step(() => c.observe(mk({ hoursAlive: 5.5, hour: 10, inBldg: { id: 'h1' }, outside: false }), { run: 'r1', searched: 0 }));
await step(() => c.order({ action: 'SEARCH', thought: 'Check the kitchen for food' }));
await step(() => c.observe(mk({ hoursAlive: 6, hour: 11, kills: 1, hp: 70, bleeding: 1, weapon: 'Baseball Bat', weaponScore: 20, inBldg: { id: 'h1' }, outside: false }), { run: 'r1', searched: 1 }));
await step(() => c.order({ action: 'BANDAGE', thought: 'The bleeding has to stop first' }));
await step(() => c.order({ action: 'SECURE', thought: 'Lock the doors before the dead wander in' }));
clock.t += IDLE_MIN_MS;
await c.maybeRun();
const warm = times.slice(1).sort((a, b) => a - b);
if (c.lastError) console.log(`last error: ${c.lastError}`);
console.log(`prompt sizes (chars): ${sent.map((r) => r.user.length).join(', ')}`);
console.log(`warm lines: min ${warm[0]} ms, median ${warm[Math.floor(warm.length / 2)]} ms, max ${warm[warm.length - 1]} ms`);
// The longest prompt of the run is what the menu turn is timed against below.
const longest = sent.reduce((m, r) => (r.user.length > m.user.length ? r : m), sent[0]);
const say = () => callCommentary({ system: SYSTEM, user: longest.user });

const turn = async () => {
  const t = Date.now();
  const r = await callChoice(plan.user, ids);
  parseChoice(r.raw, ids);
  return Date.now() - t;
};
await turn();
const alone = [];
for (let i = 0; i < reps; i++) alone.push(await turn());
console.log(`menu turn alone: ${alone.join(', ')} ms`);

const during = [];
const cut = [];
for (let i = 0; i < reps; i++) {
  const comment = say().then(() => 'finished', (e) => (e.preempted ? 'cut' : `error ${e.message}`));
  await sleep(700);
  const busyThen = commentBusy();
  during.push(await turn());
  cut.push(`${busyThen ? 'was writing' : 'already done'} -> ${await comment}`);
}
console.log(`menu turn during a thought: ${during.join(', ')} ms (${cut.join('; ')})`);
