// Brain half. The mod writes senses, this asks Ollama, then writes one intent line.
//
//   Project Zomboid  --local_percept.txt-->  this process  --Ollama-->  local model
//                    <--local_intent.txt---
//
// Watch it at http://localhost:8799/mind

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM, BACKEND, MODEL } from './llm.mjs';
import { buildPrompt, extractJSON, normalize, steerJob, intentLine, zombieInside } from './decide.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8799);
const LUA_DIR = path.join(os.homedir(), 'Zomboid', 'Lua');
const PERCEPT_FILE = path.join(LUA_DIR, 'local_percept.txt');
const INTENT_FILE = path.join(LUA_DIR, 'local_intent.txt');
const STATE_FILE = path.join(DIR, 'pz-state.json');

function writeIntentFile(line) {
  fs.mkdirSync(LUA_DIR, { recursive: true });
  const tmp = INTENT_FILE + '.tmp';
  fs.writeFileSync(tmp, line + '\n');
  try {
    fs.renameSync(tmp, INTENT_FILE);
  } catch {
    // Windows can refuse the replace while the game has the file open.
    fs.copyFileSync(tmp, INTENT_FILE);
    fs.rmSync(tmp, { force: true });
  }
}

let state = {
  seq: 0,
  memory: '(fresh mind)',
  log: [],
  deaths: 0,
  goal: '',
  subtask: '',
  chat: [],
};
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
} catch { /* first run */ }

const saveState = () => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, log: state.log.slice(-200) }));
  } catch { /* disk */ }
};

let percept = null;
let perceptAt = 0;
let perceptMtime = 0;
let intent = '0|WAIT|0|0|';
let lastThought = '(waking up)';
let lastAction = '-';
let brainNote = 'idle';
let inFlight = false;
let godQueue = [];
let eulogized = false;
let lastGameErr = '';

const log = (kind, text) => {
  const line = { t: new Date().toISOString().slice(11, 19), kind, text: String(text).slice(0, 400) };
  state.log.push(line);
  console.log(`[${line.t}] ${kind}: ${line.text}`);
};

function readPercept() {
  try {
    const mt = fs.statSync(PERCEPT_FILE).mtimeMs;
    if (mt === perceptMtime) return;
    percept = JSON.parse(fs.readFileSync(PERCEPT_FILE, 'utf8'));
    perceptMtime = mt;
    perceptAt = Date.now();
  } catch { /* partial write, or the game is not up */ }
}
setInterval(readPercept, 1000);

async function decide() {
  if (inFlight) return;
  if (!percept || Date.now() - perceptAt > 15000) {
    brainNote = 'no fresh percept (game running, mod enabled?)';
    return;
  }
  if (percept.err && percept.err !== lastGameErr) {
    lastGameErr = percept.err;
    log('game', percept.err);
  } else if (!percept.err) {
    lastGameErr = '';
  }
  if (percept.dead) {
    if (!eulogized) {
      eulogized = true;
      state.deaths += 1;
      state.goal = '';
      state.subtask = '';
      state.memory = `Died on day ${percept.day}.`;
      log('death', `Run ended. Nights survived: ${percept.day}.`);
      brainNote = 'dead. Load or start a character and this resumes.';
      saveState();
    }
    return;
  }
  eulogized = false;
  // The flee is already the right move. A thought takes long enough to walk her back in.
  if (zombieInside(percept)) {
    if (brainNote !== 'reflex, zombie inside 10') {
      brainNote = 'reflex, zombie inside 10';
      log('decide', 'Zombie inside 10 tiles. No order.');
    }
    return;
  }
  const seen = Number(percept.lastSeq) || 0;
  if (seen > state.seq) state.seq = seen;
  inFlight = true;
  brainNote = 'thinking';
  const god = godQueue.splice(0);
  const prompt = buildPrompt(state, percept, god);
  try {
    let raw = '';
    let parsed;
    try {
      raw = await callLLM(prompt);
      parsed = extractJSON(raw);
    } catch (err) {
      const msg = String(err && err.message || err);
      if (err && err.name === 'AbortError') throw err;
      if (/ollama 4\d\d/.test(msg)) throw err;
      log('error', `parse: ${msg} :: ${String(raw).slice(0, 180)}`);
      raw = await callLLM(prompt);
      parsed = extractJSON(raw);
    }
    readPercept();
    if (zombieInside(percept)) {
      if (god.length) godQueue.unshift(...god);
      brainNote = 'reflex, zombie inside 10';
      log('decide', 'Thought finished late. Zombie inside 10 tiles, order dropped.');
      return;
    }
    const decision = steerJob(normalize(parsed), percept);
    const lineBack = decision.reply || (god.length ? decision.thought : '');
    if (god.length && lineBack) {
      state.chat.push({ from: 'survivor', text: lineBack, t: new Date().toISOString().slice(11, 19) });
      state.chat = state.chat.slice(-40);
      log('reply', lineBack);
    }
    const spoken = god.length && lineBack ? lineBack : decision.say;
    if (decision.goal) state.goal = decision.goal;
    if (decision.subtask) state.subtask = decision.subtask;
    state.seq += 1;
    intent = intentLine(state.seq, { ...decision, say: spoken });
    writeIntentFile(intent);
    lastThought = decision.thought || spoken;
    lastAction = decision.type === 'MOVE' ? `MOVE ${decision.dx},${decision.dy}` : decision.type;
    if (decision.memory) state.memory = decision.memory;
    brainNote = `${BACKEND} ${MODEL}`;
    log('decide', `[${state.subtask}] ${lastAction}${spoken ? ` "${spoken}"` : ''} ${lastThought}`);
    saveState();
  } catch (err) {
    brainNote = `brain error: ${err.message}`;
    log('error', err.message);
  } finally {
    inFlight = false;
  }
}

function cadence() {
  if (!percept || percept.dead) return 10000;
  // Close enough to bite: look again soon, but decide() will not call the model.
  if (percept.zClose > 0) return 1000;
  if (percept.zNear > 0) return 5000;
  if (percept.qlen > 0) return 6000;
  return 4000;
}

(function loop() {
  decide().finally(() => setTimeout(loop, cadence()));
})();

const PAGE = `<!doctype html><meta charset="utf-8"><title>Local survivor</title>
<style>
body{background:#101418;color:#dde3ea;font:14px/1.5 system-ui,Segoe UI,sans-serif;max-width:860px;margin:24px auto;padding:0 16px}
h1{font-size:18px;color:#7fd1b9}.bubble{background:#1c2733;border-left:3px solid #7fd1b9;padding:10px 14px;border-radius:6px;margin:8px 0}
.say{color:#ffd479}.grid{display:flex;gap:18px;flex-wrap:wrap}.stat{background:#151b22;padding:8px 12px;border-radius:6px;min-width:96px}
.stat b{display:block;font-size:11px;color:#8899aa;text-transform:uppercase}
#log,#chat{background:#0c0f13;border-radius:6px;padding:10px;max-height:280px;overflow:auto}
input{flex:1;background:#151b22;border:1px solid #26303a;color:#dde3ea;padding:8px;border-radius:6px}
button{padding:8px 14px;border:0;border-radius:6px;background:#7fd1b9;color:#0c0f13;font-weight:600}
.note{color:#8899aa;font-size:12px}
</style>
<h1>Local survivor</h1>
<div class="note" id="note"></div>
<div class="bubble"><b class="note">Goal</b><div id="goal"></div><div class="note" id="sub"></div></div>
<div class="bubble" id="thought"></div>
<div class="bubble say" id="say"></div>
<div class="grid" id="stats"></div>
<h1 style="font-size:14px">Voice</h1>
<div id="chat"></div>
<p style="display:flex;gap:8px"><input id="god" placeholder="say something" onkeydown="if(event.key==='Enter')sendGod()"><button onclick="sendGod()">send</button></p>
<h1 style="font-size:14px">Log</h1>
<pre id="log"></pre>
<script>
async function tick(){
  const s = await (await fetch('/api/state')).json();
  const p = s.percept;
  document.getElementById('note').textContent = s.brainNote + ' · ' + s.lastAction + (p ? ' · day ' + p.day + ' ' + p.hour + ':00' : '');
  document.getElementById('goal').textContent = s.goal || '(setting a goal)';
  document.getElementById('sub').textContent = s.subtask || '';
  document.getElementById('thought').textContent = s.lastThought || '';
  document.getElementById('say').textContent = s.lastSay || '';
  document.getElementById('stats').textContent = p ? ('hp ' + p.hp + '  hunger ' + p.hunger + '  thirst ' + p.thirst + '  zombies ' + p.zClose + ' close / ' + p.zNear + ' near') : 'no senses yet';
  document.getElementById('chat').textContent = (s.chat || []).map(m => m.t + ' ' + m.from + ': ' + m.text).join('\\n');
  document.getElementById('log').textContent = (s.log || []).slice().reverse().map(l => '[' + l.t + '] ' + l.kind + ': ' + l.text).join('\\n');
}
async function sendGod(){
  const i = document.getElementById('god');
  if (!i.value) return;
  const text = i.value; i.value = '';
  await fetch('/god?text=' + encodeURIComponent(text));
  tick();
}
setInterval(tick, 2000); tick();
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      percept,
      perceptFresh: Date.now() - perceptAt < 5000,
      seq: state.seq,
      lastThought,
      lastSay: (intent.split('|')[4] || ''),
      lastAction,
      brainNote,
      goal: state.goal,
      subtask: state.subtask,
      chat: state.chat.slice(-24),
      memory: state.memory,
      log: state.log.slice(-60),
      model: MODEL,
    }));
  }
  if (url.pathname === '/god') {
    const text = (url.searchParams.get('text') || '').slice(0, 300);
    if (text) {
      godQueue.push(text);
      log('god', text);
      state.chat.push({ from: 'you', text, t: new Date().toISOString().slice(11, 19) });
      state.chat = state.chat.slice(-40);
      saveState();
    }
    res.writeHead(200);
    return res.end('ok');
  }
  if (url.pathname === '/' || url.pathname === '/mind') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE);
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, '127.0.0.1', () => {
  log('boot', `up on http://localhost:${PORT}/mind  brain ${BACKEND} (${MODEL})  senses ${PERCEPT_FILE}`);
  readPercept();
});
