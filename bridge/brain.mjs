// One turn of the v2 brain, without any I/O. pz-bridge.mjs reads the files and calls Ollama,
// this decides who gets the turn and what the order line says.
//
//   hold     a chaser inside 10 or a seen zombie inside 3: the reflex owns it, no order
//   handback the reflex has held it too long without getting away (chase.mjs): the model
//            picks from a short escape menu instead of the hold
//   asleep   no order, a MOVE or GOTO would wake him into the dark
//   pending  the last order is not picked up yet
//   skill    a long job is running and nothing that matters changed
//   policy   a need that cannot wait picks the option, no model call
//   ask      the model picks one id from the menu

import { holdReason, running, needs, chasing, isAsleep } from './senses.mjs';
import { memoryStats } from './memory.mjs';
import { buildOptions, escapeOptions, optionLines, runningKey } from './options.mjs';
import { decidePolicy } from './policy.mjs';
import { selectRules } from './playbook.mjs';
import { activeLessons } from './lessons.mjs';
import { planLines } from './planner.mjs';
import { digest } from './digest.mjs';
import { intentLine } from './decide.mjs';
import { pickExamples, exampleLines } from './nudges.mjs';
import { reactionContext } from './reactions.mjs';
import { jobLine } from './housejob.mjs';

export const RECHECK_MS = 20_000;
export const PENDING_MS = 10_000;
export const WAIT_RECHECK_MS = 8_000;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export { chasing };

// What a busy turn compares against, saved whenever the brain decides.
export function snapshot(p, now) {
  return { at: now, needs: [...needs(p)], chasing: chasing(p) };
}

// While a skill runs, only a chase starting, a new need, a voice or the 20 second recheck
// is worth a model call. The GPU is shared with the game.
function changedSince(p, last, now, voice, recheck = RECHECK_MS) {
  if (voice && voice.length) return 'a voice spoke';
  if (!last) return 'first look';
  if (now - num(last.at) >= recheck) return `${Math.round(recheck / 1000)} second check`;
  if (chasing(p) > 0 && num(last.chasing) === 0) return 'a zombie started chasing';
  const before = new Set(last.needs || []);
  const fresh = [...needs(p)].find((n) => !before.has(n));
  return fresh ? `new need: ${fresh}` : '';
}

// recent: how the last orders went, one line each. extra: { plan (the planner's), lessons (the ones
// whose trigger holds now), examples (lines from past nudges, already worded), blocked (orders map
// memory keeps off the menu, with why), pattern (one line when the last orders go in circles) }
export function userMessage(p, mem, options, rules, voice, recent, extra = {}) {
  const parts = [`SITUATION:\n${digest(p, memoryStats(mem))}`];
  const plan = planLines(extra.plan);
  if (plan) parts.push(plan);
  if (extra.job) parts.push(extra.job);
  const lessons = extra.lessons || [];
  if (rules.length || lessons.length) {
    const lines = [...rules.map((r) => r.text), ...lessons.map((l) => `Lesson from a past run: ${l.text}`)];
    parts.push(`RULES FOR NOW:\n${lines.map((t) => `- ${t}`).join('\n')}`);
  }
  const examples = extra.examples || [];
  if (examples.length) parts.push(`EXAMPLES:\n${examples.map((t) => `- ${t}`).join('\n')}`);
  if (recent && recent.length) parts.push(`RECENT CHOICES:\n${recent.map((r) => `- ${r}`).join('\n')}`);
  const blocked = extra.blocked || [];
  if (blocked.length) parts.push(`NOT ON THE MENU NOW:\n${blocked.map((r) => `- ${r}`).join('\n')}`);
  if (extra.pattern) parts.push(extra.pattern);
  if (extra.escape) parts.push(extra.escape);
  if (voice && voice.length) {
    parts.push(`A voice only you can hear says: ${voice.map((v) => `"${String(v).slice(0, 200)}"`).join(' ')} Answer it in the thought, one short sentence.`);
  }
  parts.push(`OPTIONS:\n${optionLines(options)}`);
  parts.push(`Pick one id: ${options.map((o) => o.id).join(', ')}.`);
  return parts.join('\n\n');
}

// ctx: { now, last (a snapshot), pending ({ seq, at }), voice (lines), history (the tracker's orders
//        with their results), run (the stats run id, so another character's orders are left out),
//        plan (the planner's), lessons (every stored lesson), nudges (indexed past nudges, or
//        nothing to leave the examples out),
//        handBack ({ why, ms } from chase.mjs: the reflex has had this chase too long) }
export function planTurn(p, mem, ctx = {}) {
  const now = ctx.now ?? Date.now();
  if (!p) return { kind: 'none', why: 'no senses' };
  if (p.dead) return { kind: 'dead', why: 'dead' };
  const hold = holdReason(p);
  // A hand-back only means something while the hold is on.
  const back = hold && ctx.handBack ? ctx.handBack : null;
  if (hold && !back) return { kind: 'hold', why: hold };
  if (isAsleep(p, mem)) return { kind: 'asleep', why: 'asleep' };
  const pending = ctx.pending;
  if (pending && num(p.lastSeq) < pending.seq && now - pending.at < PENDING_MS) {
    return { kind: 'pending', why: `order ${pending.seq} not picked up yet` };
  }
  if (back) return planHandBack(p, mem, ctx, now, hold, back);
  const options = buildOptions(p, mem, { now, plan: ctx.plan });
  const busy = running(p);
  const voice = ctx.voice || [];
  let reason = '';
  if (busy) {
    reason = changedSince(p, ctx.last, now, voice);
    if (!reason) return { kind: 'skill', why: `${busy.verb} running`, options };
  } else if (p.res && p.res.verb === 'WAIT' && p.res.status === 'running') {
    // A chosen wait is a short job too, or the model would be asked again every loop.
    reason = changedSince(p, ctx.last, now, voice, WAIT_RECHECK_MS);
    if (!reason) return { kind: 'skill', why: 'waiting, as chosen', options };
  }
  const rules = selectRules(p, mem);
  const lessons = activeLessons(ctx.lessons, p, mem);
  const react = reactionContext({ history: ctx.history, mem, p, now, run: ctx.run, options });
  const extra = { plan: ctx.plan, lessons, blocked: react.blocked, pattern: react.pattern, job: jobLine(mem, p) };
  // Only a pick on the menu the model will see can be quoted.
  const withExamples = (menu) => ({ ...extra, examples: exampleLines(pickExamples(ctx.nudges, p, menu)) });
  const policy = decidePolicy(p, mem, options);
  if (policy) {
    if (busy && policy.option.verb === busy.verb) {
      return { kind: 'skill', why: `${busy.verb} running, policy agrees`, options, rule: policy.rule, touch: true };
    }
    if (voice.length) {
      // The policy still decides; the model only gets a one-item menu so it can answer.
      const only = [policy.option];
      return { kind: 'ask', why: 'policy, voice answered by the model', options: only, offered: options, rules, policy, lessons,
        user: userMessage(p, mem, only, rules, voice, react.recent, withExamples(only)) };
    }
    return { kind: 'policy', why: policy.rule, options, rules, policy };
  }
  if (busy && options.length === 1 && !voice.length) {
    return { kind: 'skill', why: `${busy.verb} running, nothing worth stopping it for`, options, touch: true };
  }
  return { kind: 'ask', why: reason || 'free choice', options, rules, lessons,
    user: userMessage(p, mem, options, rules, voice, react.recent, withExamples(options)) };
}

// The turn the reflex handed back (chase.mjs). The menu is the escape menu. The policy is
// skipped, because a need does not end a chase. A running job does not end the turn either: it
// is what the flee keeps cancelling, so a pick that matches it is sent again (force).
function planHandBack(p, mem, ctx, now, hold, back) {
  const options = escapeOptions(p, mem, { now });
  const react = reactionContext({ history: ctx.history, mem, p, now, run: ctx.run, options });
  const secs = Math.round(num(back.ms) / 1000);
  const escape = `The reflex has had this chase for ${secs} seconds (${hold}) and running is not shaking it. Pick a way to end it.`;
  const extra = { plan: ctx.plan, lessons: [], blocked: [], pattern: '', escape, examples: [] };
  return {
    kind: 'ask', why: `hand-back: ${back.why}`, handBack: { why: back.why, ms: num(back.ms) }, force: true,
    options, rules: [], lessons: [],
    user: userMessage(p, mem, options, [], ctx.voice || [], react.recent, extra),
  };
}

// The option a decided turn sends, or null when the running job should go on. Sending the
// running job again would restart a skill, so the same job counts as "keep". force skips that:
// a handed-back turn restarts the walk on purpose.
export function resolveChoice(p, mem, options, id, force = false) {
  const option = options.find((o) => o.id === id);
  if (!option || !option.verb) return null;
  if (force) return option;
  const busy = running(p);
  if (!busy) return option;
  const job = runningKey(p, mem, options);
  if (job ? option.key === job : option.verb === busy.verb) return null;
  return option;
}

export function orderLine(seq, option, thought, say = '') {
  return intentLine(seq, {
    type: option.verb, dx: option.a ?? 0, dy: option.b ?? 0, say, thought, goal: option.label, target: option.target || '',
    // An option may carry a fight posture for the reflex. Only the escape menu sets one (options.mjs).
    posture: option.posture || '',
  });
}
