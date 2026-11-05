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

// The plan in progress, if any. A menu turn that arrives during a plan waits up to
// PLAN_GRACE_MS for it, then cancels it, so a slow plan never holds a turn for long. A warm plan
// on gemma4:12b takes 4 to 6 seconds, so most finish inside the grace; cancelling at once would
// cut nearly every plan, since menu turns come every few seconds. A cancelled plan is asked again
// after the usual gap.
export const PLAN_GRACE_MS = Number(env.PZ_PLAN_GRACE || 15000);
let planCancel = null;
let graceTimer = null;
function startTactical() {
  tacticalCalls += 1;
  const cancel = planCancel;
  if (cancel && !graceTimer) {
    graceTimer = setTimeout(() => { graceTimer = null; cancel.abort(); }, PLAN_GRACE_MS);
  }
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
    // Ollama reports nanoseconds. Reading the prompt is the part extra prompt lines slow down.
    promptMs: Math.round((Number(data.prompt_eval_duration) || 0) / 1e6),
  };
}

// The slow layer: the day plan and the death review. Its own model, token budget and timeout,
// because a thought here may run for tens of seconds and the in-game choice must never wait
// for it to be short.
// The planner measured on the 16 GB card with the game running (docs/planner.md). The game holds
// most of the VRAM, so a big model given the GPU only squeezes the menu model's compute. Run on
// the CPU with thinking off, the 35B mixture-of-experts model writes a plan in about 6 seconds
// and a menu turn right after it still takes about 0.4 seconds. Thinking only added about 110
// seconds and no better plan. These three defaults go together and only apply while
// PZ_PLANNER_MODEL is unset: a model you pick yourself keeps the old defaults (Ollama places
// it, thinking on auto). Each can still be set by hand.
export const DEFAULT_PLANNER_MODEL = 'qwen3.6-35b_abliterated_pc:latest';
const PLANNER_PINNED = !!env.PZ_PLANNER_MODEL;
export const PLANNER_MODEL = env.PZ_PLANNER_MODEL || DEFAULT_PLANNER_MODEL;
const PLANNER_TIMEOUT = Number(env.PZ_PLANNER_TIMEOUT || 120000);
const PLANNER_PREDICT = Number(env.PZ_PLANNER_PREDICT || 1500);

// Layers of the planner model to keep on the GPU. Unset leaves it to Ollama. 0 is a real value
// (all CPU), so unset is told apart from 0.
export function parseGpuLayers(v) {
  if (v == null || String(v).trim() === '' || String(v).trim().toLowerCase() === 'auto') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
const ENV_GPU_LAYERS = parseGpuLayers(env.PZ_PLANNER_GPU_LAYERS);
const ENV_THINK = (env.PZ_PLANNER_THINK || '').toLowerCase();

// Whether this model gets the tuned defaults above.
const tuned = (model) => !PLANNER_PINNED && model === DEFAULT_PLANNER_MODEL;
export const plannerGpuLayers = (model) => (ENV_GPU_LAYERS != null ? ENV_GPU_LAYERS : tuned(model) ? 0 : null);
// auto: ask for thinking and fall back for a model that refuses. off: never think.
export const plannerThinkMode = (model) => ENV_THINK || (tuned(model) ? 'off' : 'auto');
export const PLANNER_GPU_LAYERS = plannerGpuLayers(PLANNER_MODEL);

// The options block for a plan request. num_ctx is the shared one on purpose (see NUM_CTX).
export function plannerOptions(gpuLayers = PLANNER_GPU_LAYERS) {
  const o = { temperature: 0.4, num_predict: PLANNER_PREDICT, num_ctx: NUM_CTX };
  const layers = parseGpuLayers(gpuLayers);
  if (layers != null) o.num_gpu = layers;
  return o;
}

// The default planner is a custom tag that only some machines have. Ollama answers a missing
// model with a 404, and then the plan falls back to the menu model for good.
export const isMissingModel = (msg) => /404/.test(String(msg)) && /not found/i.test(String(msg));
let defaultMissing = false;

// Models Ollama said cannot think. Asked once, remembered, so the next plan does not fail twice.
const cannotThink = new Set();

export const thinkRefused = (msg) => /think/i.test(String(msg)) && /not support|unsupported|does not/i.test(String(msg));

// gpuLayers: leave undefined for the default, pass null to let Ollama place the model.
export async function callPlanner(req) {
  const useDefault = !req.model;
  if (useDefault && defaultMissing) return planWith({ ...req, model: MODEL });
  try {
    return await planWith(req);
  } catch (err) {
    if (!useDefault || PLANNER_PINNED || MODEL === PLANNER_MODEL || !isMissingModel(err && err.message)) throw err;
    defaultMissing = true;
    return planWith({ ...req, model: MODEL });
  }
}

async function planWith({ system, user, schema, model = PLANNER_MODEL, timeout = PLANNER_TIMEOUT, gpuLayers }) {
  const layers = gpuLayers === undefined ? plannerGpuLayers(model) : gpuLayers;
  if (BACKEND !== 'ollama') {
    throw new Error(`backend ${BACKEND} is not wired here. This bridge talks to Ollama.`);
  }
  const started = Date.now();
  const cancel = new AbortController();
  planCancel = cancel;
  const send = async (think) => {
    try {
      const data = await postJSON(BASE() + '/api/chat', {
        model,
        stream: false,
        think,
        format: schema,
        keep_alive: KEEP_ALIVE,
        options: plannerOptions(layers),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }, 'ollama', timeout, cancel.signal);
      // Never fall back to message.thinking: that is reasoning text, not the JSON the schema asked for.
      const msg = data.message || {};
      return { raw: msg.content || '', thought: !!msg.thinking };
    } catch (err) {
      if (cancel.signal.aborted) throw Object.assign(new Error('plan cut short by a menu turn'), { preempted: true });
      throw err;
    }
  };
  let think = plannerThinkMode(model) !== 'off' && !cannotThink.has(model);
  try {
    let reply;
    try {
      reply = await send(think);
    } catch (err) {
      if (err.preempted || !think || !thinkRefused(err && err.message)) throw err;
      cannotThink.add(model);
      think = false;
      reply = await send(false);
    }
    // Thinking can use up the whole budget and leave no answer (seen twice in a live run on
    // gemma4:12b). Ask once more without thinking rather than lose the plan.
    if (!reply.raw && think) {
      think = false;
      reply = await send(false);
    }
    if (!reply.raw) throw new Error('empty reply');
    return { raw: reply.raw, ms: Date.now() - started, thought: reply.thought, think };
  } finally {
    if (planCancel === cancel) {
      planCancel = null;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    }
  }
}
