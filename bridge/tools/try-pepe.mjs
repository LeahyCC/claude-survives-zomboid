// Time the peanut gallery against the real models (docs/brain.md, Peanut gallery).
//
//   node bridge/tools/try-pepe.mjs [--n 5]
//
// 1. Lines: how long each comment takes on the CPU, the first one apart (it carries the model load).
// 2. A menu turn alone, then a menu turn fired while a comment is being written. The comment must
//    be cut at once and the turn must stay as fast as it was alone.
import { loadFixture } from '../fixtures/load.mjs';
import { planTurn } from '../brain.mjs';
import { callChoice, parseChoice, callCommentary, commentBusy, PEPE_MODEL, MODEL } from '../llm.mjs';
import { SYSTEM, userMessage } from '../commentator.mjs';

const args = process.argv.slice(2);
const nIndex = args.indexOf('--n');
const reps = nIndex >= 0 ? Math.max(1, Number(args[nIndex + 1]) || 5) : 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [
  { text: 'She killed a zombie (4 kills this run).' },
  { text: 'She took 18 damage and is down to 40 HP.' },
  { text: 'She went into a building.' },
  { text: 'She is nearly dead, 12 HP left.' },
  { text: 'She keeps running from a house, then walking straight back into it. A loop.' },
  { text: 'She started bleeding.' },
];
const { percept, memory } = loadFixture('v2-night-outside.json');
const plan = planTurn(percept, memory, { now: 1_000_000 });
const ids = plan.options.map((o) => o.id);
const say = (i) => callCommentary({ system: SYSTEM, user: userMessage(events[i % events.length], [], percept, '') });

console.log(`# comment model ${PEPE_MODEL}, menu model ${MODEL}`);
const times = [];
for (let i = 0; i < reps + 1; i++) {
  const r = await say(i);
  times.push(r.ms);
  console.log(`${i === 0 ? 'first (load)' : 'line'} ${r.ms} ms: ${r.raw.replace(/\s+/g, ' ').slice(0, 200)}`);
}
const warm = times.slice(1).sort((a, b) => a - b);
console.log(`warm lines: min ${warm[0]} ms, median ${warm[Math.floor(warm.length / 2)]} ms, max ${warm[warm.length - 1]} ms`);

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
  const comment = say(i).then(() => 'finished', (e) => (e.preempted ? 'cut' : `error ${e.message}`));
  await sleep(700);
  const busyThen = commentBusy();
  during.push(await turn());
  cut.push(`${busyThen ? 'was writing' : 'already done'} -> ${await comment}`);
}
console.log(`menu turn during a comment: ${during.join(', ')} ms (${cut.join('; ')})`);
