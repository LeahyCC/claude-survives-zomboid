// The critic: a sober second opinion on each brain choice. After the order is sent, the same
// situation and the same menu go to Jev (TypeSafe's hosted System One model), and what it thinks is
// logged next to the decision. It never reaches the brain: not the prompt, not the order line. The
// review (bridge/tools/review.mjs) later compares the flags with how things went.
//
// This is not the inner voice. That one is a meme model for the panel. This one is a calibrated
// outside view, kept as numbers so it can be checked against outcomes.
//
// One request carries four questions, answered in parallel on their side:
//   pick      a choice over the menu the brain saw (option id -> its label)
//   danger    is she in serious danger right now (yes/no)
//   treat     should she treat wounds before anything else (yes/no)
//   mistake   is the brain's pick a mistake here (yes/no)
//
// No I/O of its own besides the fetch: the bridge hands in a write function for the log line.
// Docs: docs/brain.md ("Critic").

import { digest } from './digest.mjs';
import { recentLines } from './reactions.mjs';

export const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
// The brain's pick getting less than this much of Jev's probability counts as a flag.
export const FLAG_DEFAULT = 0.15;
// Milliseconds, like the other PZ_*_TIMEOUT settings. The game never waits on it, so short is fine.
export const TIMEOUT_DEFAULT = 3000;
// A rate limit or an overload pauses the critic: 15 s, doubling on each repeat, up to 5 minutes.
export const BACKOFF_FIRST_MS = 15_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
const LABEL_MAX = 160;
const ROWS_KEPT = 40;
const ERROR_MAX = 140;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const round = (v, k = 3) => Math.round(v * 10 ** k) / 10 ** k;

// Switches from the environment. The key is only ever returned to the caller that builds the
// request header; nothing here prints it.
export function settingsFromEnv(env = process.env) {
  const key = String(env.TYPESAFE_API_KEY || '').trim();
  const num = (v, ok, d) => {
    const s = String(v ?? '').trim();
    const n = Number(s);
    return s !== '' && Number.isFinite(n) && ok(n) ? n : d;
  };
  const off = String(env.PZ_CRITIC || '').trim() === '0' ? 'switched off with PZ_CRITIC=0' : !key ? 'no TYPESAFE_API_KEY set' : '';
  return {
    key,
    off,
    flag: num(env.PZ_CRITIC_FLAG, (n) => n >= 0 && n <= 1, FLAG_DEFAULT),
    timeout: num(env.PZ_CRITIC_TIMEOUT, (n) => n > 0, TIMEOUT_DEFAULT),
    // Only a test points this elsewhere, at a fake server on this machine.
    url: String(env.PZ_CRITIC_URL || '').trim() || API_URL,
  };
}

// What Jev reads as its state: the digest the brain saw and how her last orders went. Game facts
// only. Built before the new order joins the history, so it matches what the brain was shown.
export function situationText(p, stats, history, run = null) {
  const parts = [digest(p, stats)];
  const recent = recentLines(history, p, run);
  if (recent.length) parts.push(`Her last orders:\n${recent.map((r) => `- ${r}`).join('\n')}`);
  return parts.join('\n\n');
}

const cleanLabel = (o) => String(o.label || o.id).replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) || String(o.id);

// The menu as the brain saw it: [{ id, label }]. Anything without an id is dropped.
export function cleanMenu(menu) {
  const seen = new Set();
  const out = [];
  for (const o of Array.isArray(menu) ? menu : []) {
    if (!isObj(o) || o.id == null || seen.has(String(o.id))) continue;
    seen.add(String(o.id));
    out.push({ id: String(o.id), label: cleanLabel(o) });
  }
  return out;
}

const PICK_Q = 'A survivor in a zombie game must pick her next job. Staying alive comes first. Which option is best for her right now?';
const DANGER_Q = 'Is the survivor in serious danger right now?';
const TREAT_Q = 'Should the survivor treat her wounds before doing anything else?';

// The request body. only: 'pick' leaves out the yes/no questions (the eval does not need them).
// Returns null when there is no menu to ask about.
export function buildRequest({ state, menu, choice, only = '', model = MODEL }) {
  const options = cleanMenu(menu);
  if (!options.length) return null;
  const chosen = options.find((o) => o.id === choice);
  const questions = {
    pick: { type: 'choice', instructions: PICK_Q, criteria: Object.fromEntries(options.map((o) => [o.id, o.label])) },
  };
  if (only !== 'pick') {
    questions.danger = { type: 'noul', instructions: DANGER_Q };
    questions.treat = { type: 'noul', instructions: TREAT_Q };
    // The chosen option is named in the question because the state is the same for every question.
    questions.mistake = {
      type: 'noul',
      instructions: `The survivor chose this: ${chosen ? chosen.label : String(choice)}. Is that a mistake in this situation?`,
    };
  }
  return { model, state: String(state ?? ''), questions };
}

// A probability: a finite number from 0 to 1. A hair over is rounding on their side, not a fault.
function unit(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < -1e-6 || v > 1 + 1e-6) throw new Error(`${what} is not a number from 0 to 1`);
  return Math.min(1, Math.max(0, v));
}

// Checks every field of the reply that the log line will use. A reply that fails any check is
// thrown away whole: half an opinion is worse than none.
export function parseReply(data, ids, { only = '' } = {}) {
  if (!isObj(data) || !isObj(data.answers)) throw new Error('reply has no answers');
  const pick = data.answers.pick;
  if (!isObj(pick)) throw new Error('reply has no pick answer');
  if (typeof pick.choice !== 'string' || !ids.includes(pick.choice)) throw new Error('the pick is not on the menu');
  if (!isObj(pick.probabilities)) throw new Error('the pick has no probabilities');
  const probs = {};
  let sum = 0;
  for (const id of ids) {
    probs[id] = unit(pick.probabilities[id], `probability of ${id}`);
    sum += probs[id];
  }
  if (Math.abs(sum - 1) > 0.05) throw new Error('the probabilities do not sum to 1');
  const out = { top: pick.choice, probs, confidence: unit(pick.confidence, 'confidence') };
  if (only !== 'pick') {
    for (const k of ['danger', 'treat', 'mistake']) {
      const a = data.answers[k];
      if (!isObj(a)) throw new Error(`reply has no ${k} answer`);
      out[k] = unit(a.noul, k);
    }
  }
  const usage = isObj(data.usage) ? data.usage : {};
  const tokens = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  out.model = typeof data.model === 'string' ? data.model.slice(0, 40) : '';
  out.inTokens = tokens(usage.input_tokens);
  out.outTokens = tokens(usage.output_tokens);
  return out;
}

// The flag rule: the brain's pick got less than the threshold of Jev's probability.
export const isFlag = (pPick, flagAt) => pPick < flagAt;

// The decision log line. Same id as the decision it looks at.
export function criticLine({ id, choice, parsed, flagAt, ms, at }) {
  const pPick = round(parsed.probs[choice]);
  return {
    t: 'critic', id, at: new Date(at).toISOString(), model: parsed.model, pick: choice,
    top: parsed.top, pPick, pTop: round(parsed.probs[parsed.top]), confidence: round(parsed.confidence),
    danger: round(parsed.danger), treat: round(parsed.treat), mistake: round(parsed.mistake),
    agree: parsed.top === choice, flag: isFlag(pPick, flagAt), flagAt, ms, inTokens: parsed.inTokens, outTokens: parsed.outTokens,
  };
}

class HttpError extends Error {
  constructor(status, body, retryAfter) {
    super(`http ${status}${body ? `: ${body}` : ''}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// One request to Jev. Rejects on any HTTP error (with the status), a bad body, or the timeout. The
// timeout is raced as well as aborted, so a fetch that ignores the abort still lets go.
export async function postJev({ key, body, timeout = TIMEOUT_DEFAULT, fetch: doFetch = globalThis.fetch, url = API_URL }) {
  const ctl = new AbortController();
  let timer;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(Object.assign(new Error(`timed out after ${timeout} ms`), { timedOut: true })); }, timeout);
  });
  const started = Date.now();
  const call = (async () => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      let text = '';
      try { text = String(await res.text()).replace(/\s+/g, ' ').slice(0, 120); } catch { /* no body */ }
      const ra = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) : NaN;
      throw new HttpError(res.status, text, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
    }
    return res.json();
  })();
  // If the clock wins, the call may still reject later; nobody is listening by then.
  call.catch(() => {});
  try {
    const data = await Promise.race([call, clock]);
    return { data, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// What the Critic column and the status line need from one result.
function summary(line) {
  return {
    agree: line.agree, flag: line.flag, pPick: line.pPick, top: line.agree ? null : line.top,
    danger: line.danger, treat: line.treat, mistake: line.mistake, confidence: line.confidence, ms: line.ms,
  };
}

// env: the process environment (or a test's). fetch, write, now and log can be replaced in tests.
export function createCritic({ env = process.env, fetch: doFetch = globalThis.fetch, write = () => true, now = Date.now, log = () => {} } = {}) {
  const cfg = settingsFromEnv(env);
  let off = cfg.off;
  let inFlight = false;
  let backoffUntil = 0;
  let strikes = 0;
  let lastError = '';
  const rows = new Map();
  const count = { asked: 0, ok: 0, errors: 0, timeouts: 0, busy: 0, backoff: 0 };

  // The key never goes in a message: a server that echoes a header back would put it in the log.
  const scrub = (text) => (cfg.key ? String(text).split(cfg.key).join('***') : String(text));
  // One log line per kind of trouble, not one per turn. A good answer in between resets it.
  let logged = '';
  const note = (text) => {
    const t = scrub(text).slice(0, ERROR_MAX);
    if (t !== logged) log('critic', t);
    logged = t;
    lastError = t;
  };

  function failed(err) {
    if (err && err.timedOut) {
      count.timeouts += 1;
      return note(err.message);
    }
    count.errors += 1;
    const status = err && err.status;
    if (status === 429 || status === 529) {
      strikes += 1;
      const wait = err.retryAfter || Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (strikes - 1));
      backoffUntil = now() + Math.min(BACKOFF_MAX_MS, wait);
      return note(`${status === 429 ? 'rate limited' : 'overloaded'}, pausing ${Math.round(Math.min(BACKOFF_MAX_MS, wait) / 1000)} s`);
    }
    // A refused key will not start working by itself.
    if (status === 401) off = 'the key was refused (401)';
    note(err && err.message ? err.message : 'request failed');
  }

  async function run(id, req, ids, choice) {
    count.asked += 1;
    try {
      const { data, ms } = await postJev({ key: cfg.key, body: req, timeout: cfg.timeout, fetch: doFetch, url: cfg.url });
      const parsed = parseReply(data, ids);
      const line = criticLine({ id, choice, parsed, flagAt: cfg.flag, ms, at: now() });
      count.ok += 1;
      strikes = 0;
      logged = '';
      rows.set(id, summary(line));
      if (rows.size > ROWS_KEPT) rows.delete(rows.keys().next().value);
      write(line);
    } catch (err) {
      try { failed(err); } catch { /* logging must not throw */ }
    } finally {
      inFlight = false;
    }
  }

  return {
    get enabled() { return !off; },

    // Fire and forget. Returns the promise for tests (it never rejects), or null when nothing was sent.
    // At most one call is in flight; a turn that finds one running or a pause on is simply not reviewed.
    review({ id, state, menu, choice } = {}) {
      if (off || typeof id !== 'string' || !id) return null;
      const ids = cleanMenu(menu).map((o) => o.id);
      if (!ids.includes(choice)) return null;
      if (inFlight) { count.busy += 1; return null; }
      if (now() < backoffUntil) { count.backoff += 1; return null; }
      const req = buildRequest({ state, menu, choice });
      inFlight = true;
      return run(id, req, ids, choice);
    },

    rowFor: (id) => rows.get(id) || null,

    view() {
      return {
        on: !off, off, model: MODEL, flagAt: cfg.flag, timeout: cfg.timeout, ...count,
        pausedMs: Math.max(0, backoffUntil - now()), lastError,
      };
    },
  };
}
