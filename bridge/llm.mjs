// Local model call. Defaults to Ollama on purpose: a cloud key in the
// environment must not steal the turn. Set PZ_BACKEND only to leave Ollama.

import { ACTIONS } from './decide.mjs';

const env = process.env;

// Goal, subtask, say, and memory used to be in here. Gemma filled them until
// num_predict cut the object, usually through subtask, and the turn was dropped
// or retried into the same move. The job in decide.mjs still sets the goal.
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

async function postJSON(url, body, label) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
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

async function callOllama(prompt) {
  const base = env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const data = await postJSON(base + '/api/chat', {
    model: MODEL,
    stream: false,
    think: false,
    format: FORMAT,
    options: { temperature: 0.2, num_predict: 280, num_ctx: 4096 },
    messages: [{ role: 'user', content: prompt }],
  }, 'ollama');
  const msg = data.message || {};
  return msg.content || msg.thinking || '';
}

export async function callLLM(prompt) {
  if (BACKEND !== 'ollama') {
    throw new Error(`backend ${BACKEND} is not wired here. This bridge talks to Ollama.`);
  }
  return callOllama(prompt);
}
