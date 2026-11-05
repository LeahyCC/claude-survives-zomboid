// Run the fixtures through the real model and print what each turn picks and how long it took.
//
//   node bridge/tools/try-brain.mjs                     gemma4:12b, new brain and old brain
//   node bridge/tools/try-brain.mjs llama3.1:8b         another model
//   node bridge/tools/try-brain.mjs --dry               no model, just the plan and the menu
//
// Every fixture is asked twice. The first call can include loading the model; the second
// shows the warm latency the game will see. Policy turns are also put to the model with the
// full menu, to show what it would have picked.

//
//   node bridge/tools/try-brain.mjs --examples [--n 5]   time each turn with and without the
//                                                        "In a similar spot" example lines (docs/brain.md)
import { loadFixture, fixtureNames, readFixture } from '../fixtures/load.mjs';
import { planTurn, userMessage } from '../brain.mjs';
import { selectRules } from '../playbook.mjs';
import { callChoice, parseChoice, callLLM } from '../llm.mjs';
import { buildPrompt, extractJSON, normalize } from '../decide.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const noOld = args.includes('--no-old');
const examples = args.includes('--examples');
const nIndex = args.indexOf('--n');
const reps = nIndex >= 0 ? Math.max(1, Number(args[nIndex + 1]) || 5) : 5;
const models = args.filter((a, i) => !a.startsWith('--') && !(nIndex >= 0 && i === nIndex + 1));
if (!models.length) models.push(process.env.PZ_MODEL || 'gemma4:12b');

// Two example lines worded as the bridge words them, of the usual length. A real game picks them
// from past nudges (nudges.mjs); this stands in so the cost of the extra tokens can be timed alone.
function exampleLinesFor(opts) {
  const picks = opts.filter((o) => o.verb).slice(0, 2);
  return picks.map((o) => `In a similar spot, the better pick was ${o.id} (${String(o.label).slice(0, 70)}) because the door is close and the street is empty.`);
}

const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

// The same turn asked `reps` times plain and `reps` times with examples, interleaved so a drifting
// GPU clock does not favour one side. The first pair is thrown away: it carries any model load.
// The minimum is the number to read: the GPU is shared with the game and other jobs, and a slow
// call only ever adds time. The median shows how noisy the run was.
async function compareExamples(model) {
  console.log(`\n# ${model}: turn time without and with 2 example lines, best of ${reps} (first pair discarded)`);
  const rows = [];
  for (const name of fixtureNames()) {
    const { percept, memory } = loadFixture(name);
    const plan = planTurn(percept, memory, { now: 1_000_000 });
    if (!plan.options || !plan.options.length || ['skill', 'hold', 'asleep'].includes(plan.kind)) continue;
    const opts = plan.options;
    const rules = selectRules(percept, memory);
    const plain = userMessage(percept, memory, opts, rules, [], []);
    const withEx = userMessage(percept, memory, opts, rules, [], [], { examples: exampleLinesFor(opts) });
    const ids = opts.map((o) => o.id);
    const t = { a: [], b: [], readA: [], readB: [] };
    let tokA = 0;
    let tokB = 0;
    for (let i = 0; i <= reps; i++) {
      const ra = await callChoice(plain, ids, model);
      const rb = await callChoice(withEx, ids, model);
      if (i === 0) continue;
      t.a.push(ra.ms);
      t.b.push(rb.ms);
      t.readA.push(ra.promptMs);
      t.readB.push(rb.promptMs);
      tokA = ra.promptTokens;
      tokB = rb.promptTokens;
    }
    rows.push({
      fixture: name.replace(/^v2-|\.json$/g, ''), tokA, tokB,
      aMin: Math.min(...t.a), aMed: median(t.a), bMin: Math.min(...t.b), bMed: median(t.b),
      readA: Math.min(...t.readA), readB: Math.min(...t.readB),
    });
  }
  console.log('\n| fixture | plain ms (min / median) | with examples ms (min / median) | added ms (min) | prompt tokens plain / with | prompt read ms (min) plain / with |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.fixture} | ${r.aMin} / ${r.aMed} | ${r.bMin} / ${r.bMed} | ${r.bMin - r.aMin} | ${r.tokA} / ${r.tokB} | ${r.readA} / ${r.readB} |`);
  const avg = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) / rows.length);
  console.log(`\nMean over ${rows.length} fixtures: ${avg('aMin')} ms plain, ${avg('bMin')} ms with examples, ${avg('bMin') - avg('aMin')} ms added. ${avg('tokB') - avg('tokA')} more prompt tokens, ${avg('readB') - avg('readA')} ms more reading the prompt.`);
}

async function newBrain(model, name) {
  const { percept, memory } = loadFixture(name);
  const plan = planTurn(percept, memory, { now: 1_000_000 });
  const row = { fixture: name.replace(/^v2-|\.json$/g, ''), kind: plan.kind, why: plan.why, choice: '', model: '', ms: [], thought: '' };
  if (plan.kind === 'policy') row.choice = `${plan.policy.option.id} (${plan.policy.option.verb})`;
  if (dry) {
    console.log(`\n== ${name}: ${plan.kind} (${plan.why})`);
    if (plan.options) console.log(plan.options.map((o) => `  ${o.id}: ${o.label}  [${o.verb} ${o.target || ''}]`).join('\n'));
    if (plan.user) console.log(`--- user message ---\n${plan.user}`);
    return row;
  }
  if (!plan.options || !plan.options.length || plan.kind === 'skill') return row;
  const opts = plan.options;
  const user = plan.user || userMessage(percept, memory, opts, selectRules(percept, memory), [], []);
  const ids = opts.map((o) => o.id);
  for (let i = 0; i < 2; i++) {
    const r = await callChoice(user, ids, model);
    row.ms.push(r.ms);
    try {
      const c = parseChoice(r.raw, ids);
      const opt = opts.find((o) => o.id === c.choice);
      row.model = `${c.choice} (${opt.verb || 'keep'})`;
      row.thought = c.thought;
    } catch (err) {
      row.model = `bad reply: ${err.message}`;
    }
  }
  if (plan.kind === 'ask') row.choice = row.model;
  return row;
}

async function oldBrain(model, name) {
  const percept = readFixture(name);
  const prompt = buildPrompt({ goal: '', subtask: '', log: [] }, percept, []);
  const ms = [];
  let action = '';


  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    const raw = await callLLM(prompt, model);
    ms.push(Date.now() - t);
    try {
      const d = normalize(extractJSON(raw));
      action = d.type === 'MOVE' ? `MOVE ${d.dx},${d.dy}` : d.type;
    } catch (err) {
      action = `bad reply: ${err.message}`;
    }
  }

  return { action, ms };
}

const pad = (s, n) => String(s).padEnd(n);

for (const model of models) {
  if (examples) {
    await compareExamples(model);
    continue;
  }
  console.log(`\n# ${model}${dry ? ' (dry)' : ''}`);
  const rows = [];
  for (const name of fixtureNames()) {
    const row = await newBrain(model, name);
    if (!dry && !noOld) {
      const old = await oldBrain(model, name);
      row.old = old.action;
      row.oldMs = old.ms;
    }
    rows.push(row);
    if (!dry) {
      console.log(`${pad(row.fixture, 22)} ${pad(row.kind, 7)} sent=${pad(row.choice || '-', 18)} model=${pad(row.model || '-', 18)} ms=${row.ms.join('/') || '-'}  old=${row.old || '-'} ms=${(row.oldMs || []).join('/')}  "${row.thought}"`);
    }
  }
  if (!dry) {
    console.log('\n| fixture | decided by | sent | model would pick | ms (1st / warm) | old brain | old ms (1st / warm) |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows) {
      console.log(`| ${r.fixture} | ${r.kind} | ${r.choice || '-'} | ${r.model || '-'} | ${r.ms.join(' / ') || '-'} | ${r.old || '-'} | ${(r.oldMs || []).join(' / ') || '-'} |`);
    }
  }
}
