// Local model call. Defaults to Ollama on purpose: a cloud key in the
// environment must not steal the turn. Set PZ_BACKEND only to leave Ollama.

import { ACTIONS, extractJSON } from './decide.mjs';

const env = process.env;

// The old brain's reply, for a mod that still writes a v1 percept.
const FORMAT = {
  type: 'object',
  properties: {
    action: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ACTIONS },
        dx: { type: 'integer' },
        dy: { type: 'integer' },
      },
      required: ['type'],
    },
    thought: { type: 'string' },
  },
  required: ['action', 'thought'],
};

export const BACKEND = (env.PZ_BACKEND || 'ollama').toLowerCase();
export const MODEL = env.PZ_MODEL || env.OLLAMA_MODEL || 'gemma4:12b';
const TIMEOUT = Number(env.PZ_TIMEOUT || 60000);
// One context size for every call. Ollama reloads the model when num_ctx changes between
// requests, so the planner and the menu turns using different sizes cost a reload each switch.
// 8192 fits the planner's prompt plus its thinking.
const NUM_CTX = Number(env.PZ_NUM_CTX || 8192);
const BASE = () => env.OLLAMA_URL || 'http://127.0.0.1:11434';
// Unloading and reloading a 12B model costs seconds the game does not wait for.
export const KEEP_ALIVE = env.PZ_KEEP_ALIVE || '30m';
const THOUGHT_MAX = 160;

// Never changes between turns, so Ollama keeps its prompt cache for this prefix and only
// reads the new user message. Anything that varies goes in the user message.
export const SYSTEM = `You play one survivor in Project Zomboid. Each turn you get the situation, a few rules for this moment, and a short menu of options. Pick exactly one option id from the menu.

The body does the work. Every option is a whole job that runs to the end: walking, opening doors, searching rooms, drinking. A fast reflex fights or flees zombies on its own. You decide what to do next, not how to do it.

How to choose:
- Stay alive first: wounds, then thirst, hunger and sleep, then shelter, then supplies.
- Prefer houses you have not visited or searched. Searched ones are empty.
- Keep away from zombies that have not seen you.
- At night, be inside a house with the doors and curtains shut.
- If the last order failed, pick something else.
- "keep" lets the running job finish. Pick it unless something more urgent is on the menu.

Reply with JSON only, the thought first: {"thought": "...", "choice": "<option id>"}. The thought is one short first-person sentence, under 20 words. If a voice speaks to you, answer it in the thought.`;

// The choice is an enum of this turn's ids, so constrained decoding cannot produce an
// option that is not legal now. Thought comes first so the model reasons before it picks.
export function choiceSchema(ids) {
  return {
    type: 'object',
    properties: {
      thought: { type: 'string', maxLength: THOUGHT_MAX },
      choice: { type: 'string', enum: [...ids] },
    },
    required: ['thought', 'choice'],
  };
}

export function parseChoice(raw, ids) {
  const out = extractJSON(raw);
  const choice = out && typeof out.choice === 'string' ? out.choice.trim() : '';
  if (!ids.includes(choice)) throw new Error(`choice "${choice.slice(0, 20)}" is not on the menu`);
  const thought = typeof out.thought === 'string' ? out.thought.replace(/[|\r\n]/g, ' ').trim().slice(0, THOUGHT_MAX) : '';
  return { choice, thought };
}

async function postJSON(url, body, label, timeout = TIMEOUT, cancel = null) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  if (cancel) cancel.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function callOllama(prompt, model) {
  const data = await postJSON(BASE() + '/api/chat', {
    model,
    stream: false,
    think: false,
    format: FORMAT,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0.2, num_predict: 280, num_ctx: NUM_CTX },
    messages: [{ role: 'user', content: prompt }],
  }, 'ollama');
  const msg = data.message || {};
  return msg.content || msg.thinking || '';
}

// How many in-game choices are waiting on Ollama right now. The planner and the death review
// look at this before they start, so a slow thought never queues in front of a tactical turn.
let tacticalCalls = 0;
export const tacticalBusy = () => tacticalCalls > 0;

// The plan in progress, if any. A menu turn cancels it rather than queue behind it on the
// model: a plan can take a minute or more, and the plan is asked again after the usual gap.
let planCancel = null;
function startTactical() {
  tacticalCalls += 1;
  if (planCancel) planCancel.abort();
}

export async function callLLM(prompt, model = MODEL) {
  if (BACKEND !== 'ollama') {
    throw new Error(`backend ${BACKEND} is not wired here. This bridge talks to Ollama.`);
  }
  startTactical();
  try {
    return await callOllama(prompt, model);
  } finally {
    tacticalCalls -= 1;
  }
}

// One menu turn. Returns the raw reply and Ollama's own timings for the /mind page.
export async function callChoice(user, ids, model = MODEL) {
  if (BACKEND !== 'ollama') {
    throw new Error(`backend ${BACKEND} is not wired here. This bridge talks to Ollama.`);
  }
  const started = Date.now();
  startTactical();
  let data;
  try {
    data = await postJSON(BASE() + '/api/chat', {
      model,
      stream: false,
      think: false,
      format: choiceSchema(ids),
      keep_alive: KEEP_ALIVE,
      options: { temperature: 0.2, num_predict: 96, num_ctx: NUM_CTX },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    }, 'ollama');
  } finally {
    tacticalCalls -= 1;
  }
  const msg = data.message || {};
  return {
    raw: msg.content || msg.thinking || '',
    ms: Date.now() - started,
    promptTokens: Number(data.prompt_eval_count) || 0,
    outTokens: Number(data.eval_count) || 0,
  };
}

// The slow layer: the day plan and the death review. Its own model, token budget and timeout,
// because a thought here may run for tens of seconds and the in-game choice must never wait
// for it to be short.
export const PLANNER_MODEL = env.PZ_PLANNER_MODEL || MODEL;
const PLANNER_TIMEOUT = Number(env.PZ_PLANNER_TIMEOUT || 120000);
const PLANNER_PREDICT = Number(env.PZ_PLANNER_PREDICT || 1500);
// auto: ask for thinking and fall back for a model that refuses. off: never think.
const PLANNER_THINK = (env.PZ_PLANNER_THINK || 'auto').toLowerCase();
// Models Ollama said cannot think. Asked once, remembered, so the next plan does not fail twice.
const cannotThink = new Set();

export const thinkRefused = (msg) => /think/i.test(String(msg)) && /not support|unsupported|does not/i.test(String(msg));

export async function callPlanner({ system, user, schema, model = PLANNER_MODEL, timeout = PLANNER_TIMEOUT }) {
  if (BACKEND !== 'ollama') {
    throw new Error(`backend ${BACKEND} is not wired here. This bridge talks to Ollama.`);
  }
  const started = Date.now();
  const cancel = new AbortController();
  planCancel = cancel;
  const send = (think) => postJSON(BASE() + '/api/chat', {
    model,
    stream: false,
    think,
    format: schema,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0.4, num_predict: PLANNER_PREDICT, num_ctx: NUM_CTX },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, 'ollama', timeout, cancel.signal);
  let think = PLANNER_THINK !== 'off' && !cannotThink.has(model);
  let data;
  try {
    data = await send(think);
  } catch (err) {
    if (cancel.signal.aborted) throw Object.assign(new Error('plan cut short by a menu turn'), { preempted: true });
    if (!think || !thinkRefused(err && err.message)) throw err;
    cannotThink.add(model);
    think = false;
    try {
      data = await send(false);
    } catch (err2) {
      if (cancel.signal.aborted) throw Object.assign(new Error('plan cut short by a menu turn'), { preempted: true });
      throw err2;
    }
  } finally {
    if (planCancel === cancel) planCancel = null;
  }
  const msg = data.message || {};
  // Never fall back to msg.thinking: that is reasoning text, not the JSON the schema asked for.
  const raw = msg.content || '';
  if (!raw) throw new Error(think ? 'empty reply (the thinking may have used up num_predict)' : 'empty reply');
  return { raw, ms: Date.now() - started, thought: !!msg.thinking, think };
}
