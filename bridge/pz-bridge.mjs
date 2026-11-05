// Brain half. The mod writes senses, this asks Ollama, then writes one intent line.
//
//   Project Zomboid  --local_percept.txt-->  this process  --Ollama-->  local model
//                    <--local_intent.txt---
//
// A v2 percept goes through brain.mjs (docs/brain.md). A percept with no `v` field comes
// from an old mod and gets the old prompt in decide.mjs.
//
// Watch it at http://localhost:8799/mind

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { callLLM, callChoice, parseChoice, BACKEND, MODEL } from './llm.mjs';
import { buildPrompt, extractJSON, normalize, steerJob, intentLine, zombieInside } from './decide.mjs';
import { isV2, holdReason } from './senses.mjs';
import { loadMemory, updateMemory, recordOrder, memoryStats } from './memory.mjs';
import { planTurn, resolveChoice, orderLine, snapshot } from './brain.mjs';
import { loadStats, observe as observeStats, saveable as saveableStats, summary as statsSummary } from './stats.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8799);
// Both can point elsewhere, so a page check can run without touching the game's files.
const LUA_DIR = process.env.PZ_LUA_DIR || path.join(os.homedir(), 'Zomboid', 'Lua');
const PERCEPT_FILE = path.join(LUA_DIR, 'local_percept.txt');
const INTENT_FILE = path.join(LUA_DIR, 'local_intent.txt');
const STATE_FILE = process.env.PZ_STATE_FILE || path.join(DIR, 'pz-state.json');

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
  recent: [],
};
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
} catch { /* first run */ }
const map = loadMemory(state.map);
state.map = map;
if (!Array.isArray(state.recent)) state.recent = [];
const stats = loadStats(state.stats);

const saveState = () => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, stats: saveableStats(stats), log: state.log.slice(-200) }));
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
// What a busy turn is compared against, and the order the body has not picked up yet.
let lastLook = null;
let pending = null;
let lastKind = '';
let turn = { kind: 'none', why: '', decidedBy: '', options: [], choice: '', rules: [], ms: 0, at: '' };

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
    if (observeStats(stats, percept, perceptAt)) saveState();
  } catch { /* partial write, or the game is not up */ }
}
setInterval(readPercept, 1000);

function sayBack(god, line) {
  if (!god.length || !line) return '';
  state.chat.push({ from: 'survivor', text: line, t: new Date().toISOString().slice(11, 19) });
  state.chat = state.chat.slice(-40);
  log('reply', line);
  return line;
}

// The old brain, for a mod with no percept version.
async function decideV1() {
  // The flee is already the right move. A thought takes long enough to walk her back in.
  if (zombieInside(percept)) {
    if (brainNote !== 'reflex, zombie inside 10') {
      brainNote = 'reflex, zombie inside 10';
      log('decide', 'Zombie inside 10 tiles. No order.');
    }
    return;
  }
  inFlight = true;
  brainNote = 'thinking (v1 percept)';
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
    const spoken = sayBack(god, decision.reply || (god.length ? decision.thought : '')) || decision.say;
    if (decision.goal) state.goal = decision.goal;
    if (decision.subtask) state.subtask = decision.subtask;
    state.seq += 1;
    intent = intentLine(state.seq, { ...decision, say: spoken });
    writeIntentFile(intent);
    lastThought = decision.thought || spoken;
    lastAction = decision.type === 'MOVE' ? `MOVE ${decision.dx},${decision.dy}` : decision.type;
    if (decision.memory) state.memory = decision.memory;
    brainNote = `${BACKEND} ${MODEL} (v1 percept)`;
    turn = { ...turn, kind: 'v1', why: 'old mod', decidedBy: 'model (v1)', options: [], choice: lastAction, rules: [], at: new Date().toISOString().slice(11, 19) };
    log('decide', `[${state.subtask}] ${lastAction}${spoken ? ` "${spoken}"` : ''} ${lastThought}`);
    saveState();
  } finally {
    inFlight = false;
  }
}

function send(option, thought, say, decidedBy) {
  state.seq += 1;
  intent = orderLine(state.seq, option, thought, say);
  writeIntentFile(intent);
  recordOrder(map, state.seq, option, percept);
  pending = { seq: state.seq, at: Date.now() };
  lastThought = thought || say || '';
  const where = option.verb === 'GOTO' ? ` ${option.a},${option.b}` : option.target ? ` ${option.target}` : '';
  lastAction = `${option.verb}${where}`;
  state.goal = option.label;
  state.subtask = `${option.id}: ${option.label}`;
  state.recent = [...state.recent, `${option.verb}: ${option.label}`.slice(0, 100)].slice(-3);
  brainNote = `${decidedBy}: ${lastAction}`;
  log('decide', `${decidedBy} ${option.id} ${lastAction}${say ? ` "${say}"` : ''} ${lastThought}`);
}

function showTurn(plan, extra = {}) {
  turn = {
    kind: plan.kind,
    why: plan.why || '',
    decidedBy: extra.decidedBy || plan.kind,
    options: (plan.offered || plan.options || []).map((o) => ({ id: o.id, verb: o.verb || 'keep', label: o.label })),
    choice: extra.choice || '',
    rules: (plan.rules || []).map((r) => r.text),
    ms: extra.ms || 0,
    at: new Date().toISOString().slice(11, 19),
  };
}

async function decideV2() {
  const now = Date.now();
  updateMemory(map, percept, now);
  const plan = planTurn(percept, map, { now, last: lastLook, pending, voice: godQueue, recent: state.recent });
  if (plan.kind !== 'pending') pending = null;
  if (['hold', 'asleep', 'pending', 'skill', 'none'].includes(plan.kind)) {
    const notes = { hold: 'reflex owns it', asleep: 'asleep, no orders', pending: 'waiting on the body', skill: 'waiting on a skill', none: 'no senses' };
    brainNote = `${notes[plan.kind]}: ${plan.why}`;
    if (plan.touch) lastLook = snapshot(percept, now);
    if (plan.kind !== 'pending') showTurn(plan, { decidedBy: notes[plan.kind] });
    if (plan.kind !== lastKind && plan.kind !== 'pending') log('decide', `${notes[plan.kind]}: ${plan.why}. No order.`);
    lastKind = plan.kind;
    return;
  }
  lastKind = plan.kind;
  if (plan.kind === 'policy') {
    lastLook = snapshot(percept, now);
    send(plan.policy.option, plan.policy.thought, '', 'policy');
    showTurn(plan, { decidedBy: `policy (${plan.policy.rule})`, choice: plan.policy.option.id });
    saveState();
    return;
  }
  inFlight = true;
  brainNote = 'thinking';
  const god = godQueue.splice(0);
  const ids = plan.options.map((o) => o.id);
  try {
    let reply;
    let picked;
    try {
      reply = await callChoice(plan.user, ids);
      picked = parseChoice(reply.raw, ids);
    } catch (err) {
      const msg = String(err && err.message || err);
      if (err && err.name === 'AbortError') throw err;
      if (/ollama 4\d\d/.test(msg)) throw err;
      log('error', `parse: ${msg} :: ${String(reply && reply.raw).slice(0, 180)}`);
      reply = await callChoice(plan.user, ids);
      picked = parseChoice(reply.raw, ids);
    }
    readPercept();
    const late = holdReason(percept);
    if (late) {
      if (god.length) godQueue.unshift(...god);
      brainNote = `reflex owns it: ${late}`;
      log('decide', `Thought finished late (${late}). Order dropped.`);
      showTurn(plan, { decidedBy: 'dropped late', choice: picked.choice, ms: reply.ms });
      return;
    }
    lastLook = snapshot(percept, Date.now());
    const decidedBy = plan.policy ? `policy (${plan.policy.rule}), voice answered by ${MODEL}` : `model ${MODEL}`;
    showTurn(plan, { decidedBy, choice: picked.choice, ms: reply.ms });
    const spoken = sayBack(god, picked.thought);
    const option = resolveChoice(percept, map, plan.options, picked.choice);
    if (!option) {
      lastThought = picked.thought;
      brainNote = `model: keep (${picked.choice})`;
      log('decide', `model keeps the running job. ${picked.thought}`);
    } else {
      send(option, picked.thought, spoken, 'model');
    }
    saveState();
  } catch (err) {
    // A failed call must not eat what was said on the page.
    if (god.length) godQueue.unshift(...god);
    throw err;
  } finally {
    inFlight = false;
  }
}

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
      // Places stay known for the next character. Orders, fails and sleep belonged to this one.
      map.orders = [];
      map.fails = {};
      map.sleep = null;
      pending = null;
      log('death', `Run ended. Nights survived: ${percept.day}.`);
      brainNote = 'dead. Load or start a character and this resumes.';
      saveState();
    }
    return;
  }
  eulogized = false;
  const seen = Number(percept.lastSeq) || 0;
  if (seen > state.seq) state.seq = seen;
  try {
    if (isV2(percept)) await decideV2();
    else await decideV1();
  } catch (err) {
    brainNote = `brain error: ${err.message}`;
    log('error', err.message);
  }
}

function cadence() {
  if (!percept || percept.dead) return 10000;
  if (!isV2(percept)) {
    if (percept.zClose > 0) return 1000;
    if (percept.zNear > 0) return 5000;
    if (percept.qlen > 0) return 6000;
    return 4000;
  }
  // Holding or waiting on the body costs nothing, so look again soon.
  if (turn.kind === 'hold' || pending) return 1000;
  if (turn.kind === 'skill' || turn.kind === 'asleep') return 2000;
  return 3000;
}

(function loop() {
  decide().finally(() => setTimeout(loop, cadence()));
})();

const PAGE = `<!doctype html><meta charset="utf-8"><title>Local survivor</title>
<style>
body{background:#101418;color:#dde3ea;font:14px/1.5 system-ui,Segoe UI,sans-serif;max-width:860px;margin:24px auto;padding:0 16px}
h1{font-size:18px;color:#7fd1b9}h2{font-size:14px;color:#7fd1b9;margin:18px 0 6px}
.bubble{background:#1c2733;border-left:3px solid #7fd1b9;padding:10px 14px;border-radius:6px;margin:8px 0}
.say{color:#ffd479}.grid{display:flex;gap:18px;flex-wrap:wrap}.stat{background:#151b22;padding:8px 12px;border-radius:6px;min-width:96px}
.stat b{display:block;font-size:11px;color:#8899aa;text-transform:uppercase}
#log,#chat{background:#0c0f13;border-radius:6px;padding:10px;max-height:280px;overflow:auto;white-space:pre-wrap}
input{flex:1;background:#151b22;border:1px solid #26303a;color:#dde3ea;padding:8px;border-radius:6px}
button{padding:8px 14px;border:0;border-radius:6px;background:#7fd1b9;color:#0c0f13;font-weight:600}
.note{color:#8899aa;font-size:12px}
#options{list-style:none;padding:0;margin:0}#options li{padding:4px 10px;border-radius:4px;margin:2px 0;background:#151b22}
#options li.chosen{background:#1f3b33;border-left:3px solid #7fd1b9}#options code{color:#ffd479;margin-right:8px}
#rules{margin:0;padding-left:18px;color:#c4ccd6}
#runs{border-collapse:collapse;width:100%}#runs th,#runs td{text-align:left;padding:3px 10px;background:#151b22;border-bottom:2px solid #101418}
#runs th{font-size:11px;color:#8899aa;text-transform:uppercase}#runs tr.live td{color:#7fd1b9}
</style>
<h1>Local survivor</h1>
<div class="note" id="note"></div>
<div class="bubble"><b class="note">Goal</b><div id="goal"></div><div class="note" id="sub"></div></div>
<div class="bubble" id="thought"></div>
<div class="bubble say" id="say"></div>
<div class="grid" id="stats"></div>
<h2>This turn</h2>
<div class="grid">
<div class="stat"><b>Decided by</b><span id="by"></span></div>
<div class="stat"><b>Choice</b><span id="choice"></span></div>
<div class="stat"><b>Model time</b><span id="ms"></span></div>
<div class="stat"><b>Map memory</b><span id="map"></span></div>
</div>
<h2>Options offered</h2>
<ul id="options"></ul>
<h2>Playbook rules used</h2>
<ul id="rules"></ul>
<h2>Runs</h2>
<table id="runs"><thead><tr><th>started</th><th>hours</th><th>kills</th><th>day</th><th>damage</th><th>searched</th><th>ended by</th></tr></thead><tbody></tbody></table>
<h2>Voice</h2>
<div id="chat"></div>
<p style="display:flex;gap:8px"><input id="god" placeholder="say something" onkeydown="if(event.key==='Enter')sendGod()"><button onclick="sendGod()">send</button></p>
<h2>Log</h2>
<pre id="log"></pre>
<script>
function fill(id, items, make){
  const el = document.getElementById(id);
  el.replaceChildren(...items.map(make));
}
async function tick(){
  const s = await (await fetch('/api/state')).json();
  const p = s.percept;
  const t = s.turn || {};
  document.getElementById('note').textContent = s.brainNote + ' · ' + s.lastAction + (p ? ' · day ' + p.day + ' ' + p.hour + ':00' : '');
  document.getElementById('goal').textContent = s.goal || '(setting a goal)';
  document.getElementById('sub').textContent = s.subtask || '';
  document.getElementById('thought').textContent = s.lastThought || '';
  document.getElementById('say').textContent = s.lastSay || '';
  document.getElementById('stats').textContent = p ? ('hp ' + p.hp + '  hunger ' + p.hunger + '  thirst ' + p.thirst + '  zombies ' + p.zClose + ' close / ' + p.zNear + ' near' + (p.zChasing != null ? ' / ' + p.zChasing + ' chasing' : '')) : 'no senses yet';
  document.getElementById('by').textContent = (t.decidedBy || '-') + (t.why ? ' (' + t.why + ')' : '');
  document.getElementById('choice').textContent = t.choice || '-';
  document.getElementById('ms').textContent = t.ms ? t.ms + ' ms' : '-';
  const m = s.map || {};
  document.getElementById('map').textContent = (m.buildings || 0) + ' buildings, ' + (m.visited || 0) + ' visited, ' + (m.searched || 0) + ' searched';
  fill('options', t.options || [], (o) => {
    const li = document.createElement('li');
    if (o.id === t.choice) li.className = 'chosen';
    const c = document.createElement('code'); c.textContent = o.id;
    li.append(c, document.createTextNode(o.label + ' [' + o.verb + ']'));
    return li;
  });
  fill('rules', t.rules || [], (r) => { const li = document.createElement('li'); li.textContent = r; return li; });
  const st = await (await fetch('/api/stats')).json();
  const body = document.querySelector('#runs tbody');
  body.replaceChildren(...[st.current, ...st.runs].filter(Boolean).map((r) => {
    const tr = document.createElement('tr');
    if (r.live) tr.className = 'live';
    const when = r.start ? r.start.slice(5, 16).replace('T', ' ') : '-';
    for (const v of [when, r.hoursSurvived, r.kills, r.day, r.damage, r.searched, r.live ? 'alive' : r.cause]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    return tr;
  }));
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
      turn,
      map: memoryStats(map),
    }));
  }
  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(statsSummary(stats)));
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
