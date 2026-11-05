// The scoreboard. Runs every scenario through the real turn path (options, policy, prompt,
// model) and counts how often the pick is one a good player would accept.
//
//   node bridge/eval/run.mjs                      default model, 3 runs each
//   node bridge/eval/run.mjs --model llama3.1:8b --n 2
//   node bridge/eval/run.mjs --only bleeding      one scenario
//
// A report, not a test: the exit code is always 0. Needs Ollama on OLLAMA_URL.

import { loadScenarios, buildScenario } from './scenarios.mjs';
import { planTurn } from '../brain.mjs';
import { callChoice, parseChoice, MODEL } from '../llm.mjs';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const model = flag('model', MODEL);
const n = Math.max(1, Number(flag('n', 3)) || 3);
const only = flag('only', '');

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
// Nearest-rank percentile. With a handful of samples p90 is the slowest or second slowest.
const p90 = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
};

function grade(s, id) {
  if ((s.accept || []).includes(id)) return 'accepted';
  if ((s.wrong || []).includes(id)) return 'wrong';
  return 'other';
}

// One scenario, n times. A policy turn is deterministic, so it runs once and counts n times.
async function runScenario(s) {
  const { percept, memory } = buildScenario(s);
  const plan = planTurn(percept, memory, { now: 1_000_000 });
  const row = { name: s.name, kind: plan.kind, rule: plan.rule || (plan.policy && plan.policy.rule) || '',
    accepted: 0, wrong: 0, other: 0, bad: 0, ms: [], picks: [] };
  if (plan.kind === 'policy') {
    const g = grade(s, plan.policy.option.id);
    row[g] = n;
    row.picks.push(plan.policy.option.id);
    return row;
  }
  if (plan.kind !== 'ask') {
    row.skipped = true;
    return row;
  }
  const ids = plan.options.map((o) => o.id);
  for (let i = 0; i < n; i++) {
    try {
      const r = await callChoice(plan.user, ids, model);
      row.ms.push(r.ms);
      const c = parseChoice(r.raw, ids);
      row[grade(s, c.choice)] += 1;
      row.picks.push(c.choice);
    } catch (err) {
      row.bad += 1;
      row.picks.push('error');
      row.lastError = String(err && err.message || err).slice(0, 80);
    }
  }
  return row;
}

async function reachable() {
  const base = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  try {
    const res = await fetch(base + '/api/tags');
    return res.ok;
  } catch {
    return false;
  }
}

const scenarios = loadScenarios().filter((s) => !only || s.name === only);
if (!scenarios.length) {
  console.log(`No scenario named "${only}".`);
} else if (!(await reachable())) {
  console.log('Ollama is not reachable. Start it, or set OLLAMA_URL, then run this again.');
} else {
  console.log(`# ${model}, ${n} run${n === 1 ? '' : 's'} per scenario`);
  // The first call loads the model, which would sit in the first scenario's latency.
  try {
    await callChoice('SITUATION:\nwarm up\n\nOPTIONS:\nwait: wait\n\nPick one id: wait.', ['wait'], model);
  } catch (err) {
    console.log(`Warm-up failed: ${String(err && err.message || err).slice(0, 120)}`);
  }
  const rows = [];
  for (const s of scenarios) rows.push(await runScenario(s));

  console.log('\n| scenario | by | accepted | wrong | other | bad reply | mean ms | p90 ms | picks |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const by = r.skipped ? `no order (${r.kind})` : r.kind === 'policy' ? `policy (${r.rule})` : 'model';
    console.log(`| ${r.name} | ${by} | ${r.accepted} | ${r.wrong} | ${r.other} | ${r.bad} | ${r.ms.length ? mean(r.ms) : '-'} | ${r.ms.length ? p90(r.ms) : '-'} | ${r.picks.join(' ')} |`);
  }

  const model_ = rows.filter((r) => r.kind === 'ask');
  const policy = rows.filter((r) => r.kind === 'policy');
  const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  const all = model_.flatMap((r) => r.ms);
  const total = sum(model_, 'accepted') + sum(model_, 'wrong') + sum(model_, 'other') + sum(model_, 'bad');
  console.log(`\nModel turns: ${sum(model_, 'accepted')}/${total} accepted, ${sum(model_, 'wrong')} wrong, ${sum(model_, 'other')} other, ${sum(model_, 'bad')} bad replies. Mean ${mean(all)} ms, p90 ${p90(all)} ms.`);
  console.log(`Policy turns (no model): ${policy.length} scenarios, ${policy.filter((r) => r.accepted).length} accepted, ${policy.filter((r) => r.wrong).length} wrong.`);
  const skipped = rows.filter((r) => r.skipped);
  if (skipped.length) console.log(`No order at all: ${skipped.map((r) => r.name).join(', ')}.`);
  const errs = rows.filter((r) => r.lastError);
  for (const r of errs) console.log(`Error in ${r.name}: ${r.lastError}`);
}
process.exitCode = 0;
