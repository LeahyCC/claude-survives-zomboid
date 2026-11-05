// Run the fixtures through the real model and print what each turn picks and how long it took.
//
//   node bridge/tools/try-brain.mjs                     gemma4:12b, new brain and old brain
//   node bridge/tools/try-brain.mjs llama3.1:8b         another model
//   node bridge/tools/try-brain.mjs --dry               no model, just the plan and the menu
//
// Every fixture is asked twice. The first call can include loading the model; the second
// shows the warm latency the game will see. Policy turns are also put to the model with the
// full menu, to show what it would have picked.

import { loadFixture, fixtureNames, readFixture } from '../fixtures/load.mjs';
import { planTurn, userMessage } from '../brain.mjs';
import { selectRules } from '../playbook.mjs';
import { callChoice, parseChoice, callLLM } from '../llm.mjs';
import { buildPrompt, extractJSON, normalize } from '../decide.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const noOld = args.includes('--no-old');
const models = args.filter((a) => !a.startsWith('--'));
if (!models.length) models.push(process.env.PZ_MODEL || 'gemma4:12b');

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
