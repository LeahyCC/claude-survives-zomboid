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
import { callLLM, callChoice, parseChoice, callPlanner, tacticalBusy, BACKEND, MODEL, PLANNER_MODEL } from './llm.mjs';
import { buildPrompt, extractJSON, normalize, steerJob, intentLine, zombieInside } from './decide.mjs';
import { isV2, holdReason } from './senses.mjs';
import { loadMemory, updateMemory, recordOrder, memoryStats, memorySlice } from './memory.mjs';
import { planTurn, resolveChoice, orderLine, snapshot } from './brain.mjs';
import { createPlanner } from './planner.mjs';
import { loadLessons, addLessons, recordRun, deleteLesson, lessonStats, reviewDeath } from './lessons.mjs';
import { digest } from './digest.mjs';
import { loadStats, observe as observeStats, saveable as saveableStats, summary as statsSummary } from './stats.mjs';
import { createTracker } from './decisions.mjs';
import { createAppender, readLog, DEFAULT_MAX_BYTES } from './jsonl.mjs';
import { parseNudgeBody, planNudge, planSlice, indexNudges, indexOne, examplesEnabled, MAX_BODY, MAX_INDEX } from './nudges.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8799);
// Both can point elsewhere, so a page check can run without touching the game's files.
const LUA_DIR = process.env.PZ_LUA_DIR || path.join(os.homedir(), 'Zomboid', 'Lua');
const PERCEPT_FILE = path.join(LUA_DIR, 'local_percept.txt');
const INTENT_FILE = path.join(LUA_DIR, 'local_intent.txt');
const STATE_FILE = process.env.PZ_STATE_FILE || path.join(DIR, 'pz-state.json');
const LESSONS_FILE = process.env.PZ_LESSONS_FILE || path.join(DIR, 'lessons.json');
// Append-only logs of what she chose and what Colin would have chosen (docs/eval.md).
const DECISIONS_FILE = process.env.PZ_DECISIONS_FILE || path.join(DIR, 'decisions.jsonl');
const NUDGES_FILE = process.env.PZ_NUDGES_FILE || path.join(DIR, 'nudges.jsonl');
const LOG_MAX_BYTES = Number(process.env.PZ_LOG_MAX_BYTES) || DEFAULT_MAX_BYTES;

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
const runId = () => (stats.run ? stats.run.start : null);
const tracker = createTracker({ write: createAppender(DECISIONS_FILE, { maxBytes: LOG_MAX_BYTES }) });
const appendNudge = createAppender(NUDGES_FILE, { maxBytes: LOG_MAX_BYTES });
const EXAMPLES_ON = examplesEnabled();
const pastNudges = readLog(NUDGES_FILE, { rotated: false });
let nudgeIndex = EXAMPLES_ON ? indexNudges(pastNudges) : [];
let nudgeCount = pastNudges.filter((n) => n.t === 'nudge').length;

const saveState = () => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, stats: saveableStats(stats), log: state.log.slice(-200) }));
  } catch { /* disk */ }
};

// Lessons live in their own file so wiping the mind (pz-state.json) keeps what past deaths taught.
let store = loadLessons(null);
try {
  store = loadLessons(JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8')));
} catch { /* first run, or a file that is not JSON */ }

const saveLessons = () => {
  try {
    const tmp = LESSONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    fs.renameSync(tmp, LESSONS_FILE);
  } catch { /* disk */ }
};

// What this character has done so far, for the run record written at death.
const freshRun = () => ({ hours: 0, kills: 0, day: 0, hour: 0, used: new Set(), last: null });
let run = freshRun();
let reviewNote = '';

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
// The last menus the page could have shown, newest last, so a nudge is frozen against the menu Colin
// was looking at. A new entry starts only when the options or the brain's pick change.
const MAX_SNAPSHOTS = 12;
let snapshots = [];
let snapshotSig = '';
let snapshotSerial = 0;
// When a nudge last sent an order. A model thought that started before it is dropped.
let nudgedAt = 0;

const log = (kind, text) => {
  const line = { t: new Date().toISOString().slice(11, 19), at: Date.now(), kind, text: String(text).slice(0, 400) };
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
    tracker.observe(percept, perceptAt);
  } catch { /* partial write, or the game is not up */ }
}
setInterval(readPercept, 1000);

// The slow layer. tick() never blocks: it starts a plan in the background only when no
// tactical turn is on the model and no fight is on, and the loop below does not wait for it.
const planner = createPlanner({
  plan: state.plan && typeof state.plan.goal === 'string' && Array.isArray(state.plan.steps) ? state.plan : null,
  ask: callPlanner,
  busy: tacticalBusy,
  lessons: () => store.lessons,
  log,
  onChange: () => { state.plan = planner.plan; saveState(); },
});
setInterval(() => {
  if (!percept || Date.now() - perceptAt > 15000 || !isV2(percept)) return;
  // The first plan can come before the first tactical turn has filled the map, and the plan's
  // home has to be a building the map knows. Updating twice on one percept changes nothing.
  updateMemory(map, percept, Date.now());
  planner.tick(percept, map);
}, 2000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REVIEW_WINDOW_MS = 5 * 60_000;
const REVIEW_KINDS = new Set(['decide', 'error', 'game', 'reply', 'plan', 'death']);

// After a death: the planner model reads the last minutes and writes up to 3 lessons. It runs
// in the background and waits for the model to be free; nobody is playing, so it can take its time.
async function reviewRun(finished) {
  reviewNote = 'reviewing the run';
  try {
    for (let i = 0; i < 20 && tacticalBusy(); i++) await sleep(500);
    const cutoff = Date.now() - REVIEW_WINDOW_MS;
    const all = state.log.filter((l) => REVIEW_KINDS.has(l.kind));
    const recent = all.filter((l) => (l.at || 0) >= cutoff);
    const lines = (recent.length >= 5 ? recent : all).slice(-40);
    if (!lines.length) {
      reviewNote = 'no log to review';
      return;
    }
    const res = await reviewDeath(callPlanner, {
      log: lines,
      run: finished,
      digestText: digest(finished.last, memoryStats(map)),
      final: { day: finished.day, hour: finished.hour },
      known: store.lessons,
    });
    const added = addLessons(store, res.lessons, Date.now());
    saveLessons();
    for (const l of added.added) log('lesson', `(${l.when}) ${l.text}`);
    for (const l of added.dropped) log('lesson', `dropped the oldest to stay at 20: ${l.text}`);
    reviewNote = `${added.added.length} new, ${added.duplicates} repeated, ${res.rejected.length} rejected${res.rejected.length ? ` (${res.rejected.join('; ')})` : ''}`;
    log('lesson', `review done: ${reviewNote}`);
  } catch (err) {
    reviewNote = `review failed: ${String(err && err.message || err).slice(0, 160)}`;
    log('error', reviewNote);
  }
}

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
  recordOrder(map, state.seq, option, percept, Date.now());
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
    rules: [...(plan.rules || []).map((r) => r.text), ...(plan.lessons || []).map((l) => `lesson (${l.when}): ${l.text}`)],
    ms: extra.ms || 0,
    at: new Date().toISOString().slice(11, 19),
  };
  rememberMenu(plan, extra);
}

// Keep the menu for the nudge panel. A turn with no menu (the reflex or sleep owns it) leaves the
// last one in place, so a click that was already on its way still finds what he was looking at.
function rememberMenu(plan, extra) {
  const menu = plan.offered || plan.options || [];
  if (!menu.length || !percept) return;
  // While a job runs the brain's pick is "keep", even though it never asked.
  const brain = extra.choice || (plan.kind === 'skill' && menu.some((o) => o.id === 'keep') ? 'keep' : '');
  // Labels hold distances that change every second, so they stay out of the signature.
  const sig = JSON.stringify([menu.map((o) => `${o.id}|${o.key}`), brain]);
  const fresh = {
    percept, menu, choice: brain, by: extra.decidedBy || plan.kind, rule: plan.policy ? plan.policy.rule : null,
    thought: extra.thought ?? lastThought, kind: plan.kind, memory: memorySlice(map, percept), plan: planSlice(planner.plan),
  };
  if (sig === snapshotSig && snapshots.length) {
    Object.assign(snapshots[snapshots.length - 1], fresh);
    return;
  }
  snapshotSig = sig;
  snapshotSerial += 1;
  snapshots = [...snapshots, { serial: snapshotSerial, ...fresh }].slice(-MAX_SNAPSHOTS);
}

// One line in decisions.jsonl. The log must never stop her, so a failure is swallowed.
function logDecision(plan, seen, option, d) {
  try {
    tracker.decide({
      percept: seen, run: runId(), menu: plan.offered || plan.options, option, seq: state.seq,
      rules: [...(plan.rules || []).map((r) => r.id), ...(plan.lessons || []).map((l) => `lesson:${l.id}`)],
      ...d,
    }, Date.now());
  } catch (err) {
    log('error', `decision log: ${String(err && err.message || err).slice(0, 120)}`);
  }
}

async function decideV2() {
  const now = Date.now();
  // What the plan was built from. The model reply can arrive after a newer percept has.
  const seen = percept;
  updateMemory(map, percept, now);
  const plan = planTurn(percept, map, {
    now, last: lastLook, pending, voice: godQueue, recent: state.recent, plan: planner.plan, lessons: store.lessons,
    nudges: nudgeIndex,
  });
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
    showTurn(plan, { decidedBy: `policy (${plan.policy.rule})`, choice: plan.policy.option.id, thought: plan.policy.thought });
    logDecision(plan, percept, plan.policy.option, { by: 'policy', rule: plan.policy.rule, choice: plan.policy.option.id, thought: plan.policy.thought });
    saveState();
    return;
  }
  const startedAt = Date.now();
  inFlight = true;
  brainNote = 'thinking';
  const god = godQueue.splice(0);
  const ids = plan.options.map((o) => o.id);
  // A lesson that went into a prompt counts as active in this run.
  for (const l of plan.lessons || []) run.used.add(l.id);
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
    if (nudgedAt > startedAt) {
      // Colin sent an order while the model was thinking. His wins.
      if (god.length) godQueue.unshift(...god);
      log('decide', 'Thought finished after a nudge. Order dropped.');
      return;
    }
    lastLook = snapshot(percept, Date.now());
    const decidedBy = plan.policy ? `policy (${plan.policy.rule}), voice answered by ${MODEL}` : `model ${MODEL}`;
    showTurn(plan, { decidedBy, choice: picked.choice, ms: reply.ms, thought: picked.thought });
    const spoken = sayBack(god, picked.thought);
    const option = resolveChoice(percept, map, plan.options, picked.choice);
    if (!option) {
      lastThought = picked.thought;
      brainNote = `model: keep (${picked.choice})`;
      log('decide', `model keeps the running job. ${picked.thought}`);
    } else {
      send(option, picked.thought, spoken, 'model');
    }
    logDecision(plan, seen, option, { by: plan.policy ? 'policy' : 'model', rule: plan.policy ? plan.policy.rule : null, choice: picked.choice, thought: picked.thought, ms: reply.ms });
    saveState();
  } catch (err) {
    // A failed call must not eat what was said on the page.
    if (god.length) godQueue.unshift(...god);
    throw err;
  } finally {
    inFlight = false;
  }
}

// Hours and kills only go up within one character. A drop means a new character that the
// bridge did not see die (loaded another save), so the old tally is let go, not recorded.
function trackRun(p) {
  const hours = Number(p.hoursAlive);
  if (Number.isFinite(hours)) {
    if (hours < run.hours - 0.05) run = freshRun();
    run.hours = Math.max(run.hours, hours);
  }
  run.kills = Math.max(run.kills, Number(p.kills) || 0);
  run.day = Number(p.day) || 0;
  run.hour = Number(p.hour) || 0;
  run.last = p;
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
      // A run we never saw alive has nothing to learn from.
      if (run.last) {
        const finished = run;
        recordRun(store, { hours: finished.hours, kills: finished.kills, used: [...finished.used] }, Date.now());
        saveLessons();
        planner.reset();
        reviewRun(finished);
      }
      run = freshRun();
    }
    return;
  }
  eulogized = false;
  trackRun(percept);
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

// Read the senses once before the first turn. Without this the first look finds no percept and
// the loop waits the 10 seconds it uses for "no game" before looking again.
readPercept();
(function loop() {
  decide().finally(() => setTimeout(loop, cadence()));
})();

function lessonView() {
  const stats = new Map(lessonStats(store).map((s) => [s.id, s]));
  return store.lessons.map((l) => ({ ...l, ...stats.get(l.id) }));
}

// The newest menu, as the nudge panel draws it.
function nudgeView() {
  const s = snapshots[snapshots.length - 1];
  if (!s) return null;
  return {
    serial: s.serial, brain: s.choice, kind: s.kind,
    options: s.menu.map((o) => ({ id: o.id, verb: o.verb || 'keep', label: o.label, key: o.key || '' })),
  };
}

// Colin's order goes out through send(), the same call a policy order uses.
function sendNudge(option, why, menu) {
  const now = Date.now();
  nudgedAt = now;
  lastLook = snapshot(percept, now);
  const thought = (why ? `Colin picked this: ${why}` : 'Colin picked this.').replace(/[|\r\n]/g, ' ').slice(0, 160);
  send(option, thought, '', 'nudge');
  turn = { ...turn, decidedBy: 'nudge (Colin)', why: 'picked on the page', choice: option.id, at: new Date().toISOString().slice(11, 19) };
  logDecision({ options: menu }, percept, option, { by: 'nudge', rule: null, choice: option.id, thought });
  saveState();
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleNudge(req, res) {
  // Same guard as the lesson delete: a custom header forces a preflight this server never answers.
  if (req.headers['x-mind'] !== '1') {
    res.writeHead(403);
    return res.end();
  }
  const text = await readBody(req, MAX_BODY);
  if (text === null) return sendJson(res, 413, { ok: false, message: 'That request was too big.' });
  const body = parseNudgeBody(text);
  if (!body.ok) return sendJson(res, 400, body);
  const got = planNudge(body, {
    snapshots, percept, perceptAt, map, now: Date.now(), run: runId(),
    resolve: (menu, id) => resolveChoice(percept, map, menu, id),
  });
  if (!got.ok) return sendJson(res, got.status, { ok: false, message: got.message });
  // Written before anything is sent, so an order never goes out without its record.
  if (!appendNudge(got.record)) return sendJson(res, 500, { ok: false, message: 'Could not write nudges.jsonl. Nothing was sent.' });
  nudgeCount += 1;
  if (EXAMPLES_ON && got.record.pickKey) nudgeIndex = [...nudgeIndex, indexOne(got.record)].slice(-MAX_INDEX);
  if (got.order) sendNudge(got.order, got.record.why, got.record.menu);
  const picked = got.record.pick ? `${got.record.pick} (${got.record.pickVerb || 'keep'})` : 'a missing option';
  log('nudge', `${body.mode}: ${picked}; brain had ${got.record.brain.id || 'nothing'}${got.record.why ? `; ${got.record.why}` : ''}`);
  sendJson(res, 200, {
    ok: true, applied: !!got.order,
    message: got.order ? `Sent ${got.record.pick}. Logged.` : 'Logged. Nothing changed in the game.',
  });
}

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
#steps{margin:4px 0 0;padding-left:18px;color:#c4ccd6}
#lessons{list-style:none;padding:0;margin:0}#lessons li{padding:6px 10px;border-radius:4px;margin:3px 0;background:#151b22}
#lessons li.flag{border-left:3px solid #e0a458}#lessons code{color:#ffd479;margin-right:8px}
.warn{color:#e0a458;font-size:12px}
.del{padding:2px 10px;margin-left:10px;background:#3a2326;color:#f3b4b4;font-weight:400}
#runs{border-collapse:collapse;width:100%}#runs th,#runs td{text-align:left;padding:3px 10px;background:#151b22;border-bottom:2px solid #101418}
#runs th{font-size:11px;color:#8899aa;text-transform:uppercase}#runs tr.live td{color:#7fd1b9}
#nudge-buttons{display:flex;flex-direction:column;gap:4px;margin:6px 0}
#nudge-buttons button{text-align:left;font-weight:400;background:#151b22;color:#dde3ea;border:1px solid #26303a}
#nudge-buttons button.brain::after{content:"  \\2190  brain's pick";color:#7fd1b9;font-size:12px}
#nudge-buttons button.sel{border-color:#ffd479;background:#2a2615}
#nudge input{width:100%;box-sizing:border-box;margin:3px 0}
#nudge .row{display:flex;gap:8px;margin-top:6px}#nudge .row button:last-child{background:#26303a;color:#dde3ea}
#nudge-msg.ok{color:#7fd1b9}
</style>
<h1>Local survivor</h1>
<div class="note" id="note"></div>
<div class="bubble"><b class="note">Goal</b><div id="goal"></div><div class="note" id="sub"></div></div>
<div class="bubble" id="thought"></div>
<div class="bubble say" id="say"></div>
<div class="grid" id="stats"></div>
<h2>Plan</h2>
<div class="bubble"><div id="plan-goal"></div><ol id="steps"></ol><div class="note" id="plan-note"></div></div>
<h2>This turn</h2>
<div class="grid">
<div class="stat"><b>Decided by</b><span id="by"></span></div>
<div class="stat"><b>Choice</b><span id="choice"></span></div>
<div class="stat"><b>Model time</b><span id="ms"></span></div>
<div class="stat"><b>Map memory</b><span id="map"></span></div>
</div>
<h2>Options offered</h2>
<ul id="options"></ul>
<h2>Nudge</h2>
<div class="bubble" id="nudge">
<div class="note" id="nudge-note">No menu yet.</div>
<div id="nudge-buttons"></div>
<label class="note" for="nudge-why">Why (short)</label>
<input id="nudge-why" maxlength="300" placeholder="why (short)" autocomplete="off">
<label class="note" for="nudge-missing">None of these fit: what option should exist?</label>
<input id="nudge-missing" maxlength="300" placeholder="none of these fit: what option should exist?" autocomplete="off">
<div class="row"><button id="nudge-now" onclick="sendNudge('now')">Do it now</button><button id="nudge-log" onclick="sendNudge('log')">Just log it</button></div>
<div class="note" id="nudge-msg"></div>
</div>
<h2>Playbook rules used</h2>
<ul id="rules"></ul>
<h2>Lessons</h2>
<div class="note" id="lessons-note"></div>
<ul id="lessons"></ul>
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
  renderNudge(s);
  const plan = s.plan;
  const pl = s.planner || {};
  document.getElementById('plan-goal').textContent = plan ? plan.goal : (pl.running ? 'thinking about a plan...' : '(no plan yet)');
  fill('steps', plan ? plan.steps : [], (t) => { const li = document.createElement('li'); li.textContent = t; return li; });
  const age = plan && p && p.hoursAlive != null ? ' · made ' + Math.max(0, p.hoursAlive - plan.hours).toFixed(1) + ' game hours ago' : '';
  document.getElementById('plan-note').textContent = [
    plan && plan.home ? 'home: building ' + plan.home : plan ? 'no home chosen' : '',
    plan ? 'asked because: ' + plan.why + age + (plan.ms ? ' · ' + Math.round(plan.ms / 1000) + ' s' : '') : '',
    pl.running ? 'planner is thinking' : '',
    pl.pending && pl.pending.length ? 'waiting to plan: ' + pl.pending.join(', ') : '',
    pl.lastError ? 'last error: ' + pl.lastError : '',
    'model ' + (pl.model || '?'),
  ].filter(Boolean).join(' · ');
  const lessons = s.lessons || [];
  document.getElementById('lessons-note').textContent = lessons.length + ' of 20 lessons · ' + (s.runsRecorded || 0) + ' runs recorded' + (s.review ? ' · last review: ' + s.review : '');
  const hrs = (x) => x == null ? 'n/a' : x.toFixed(1) + ' h';
  fill('lessons', lessons, (l) => {
    const li = document.createElement('li');
    if (l.flagged) li.className = 'flag';
    const c = document.createElement('code'); c.textContent = l.when;
    li.append(c, document.createTextNode(l.text));
    const note = document.createElement('div'); note.className = 'note';
    note.textContent = 'active in ' + l.runs + ' runs · survived ' + hrs(l.avgWith) + ' with it (' + l.runsWith + ' runs), ' + hrs(l.avgWithout) + ' without (' + l.runsWithout + ')';
    const del = document.createElement('button'); del.className = 'del'; del.textContent = 'delete';
    del.addEventListener('click', () => delLesson(l.id));
    note.append(del);
    li.append(note);
    if (l.flagged) {
      const w = document.createElement('div'); w.className = 'warn';
      w.textContent = 'Runs with this lesson ended sooner than runs without it. Worth deleting? Nothing is deleted for you.';
      li.append(w);
    }
    return li;
  });
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
// The nudge panel is built once. A refresh only rebuilds the buttons when the menu itself changed,
// and never touches the text boxes, so what is being typed or picked survives it.
const nudgeSeen = { serial: null, id: '', key: '', brain: '' };
function markNudge(){
  for (const b of document.getElementById('nudge-buttons').children) {
    b.classList.toggle('sel', b.dataset.id === nudgeSeen.id);
    b.classList.toggle('brain', b.dataset.id === nudgeSeen.brain);
  }
}
function renderNudge(s){
  const n = s.nudge;
  const t = s.turn || {};
  const box = document.getElementById('nudge-buttons');
  const note = document.getElementById('nudge-note');
  if (!n || !n.options.length) { box.replaceChildren(); nudgeSeen.serial = null; note.textContent = 'No menu yet.'; return; }
  if (n.serial !== nudgeSeen.serial) {
    // A new menu: keep the pick if the same job is still on it, else drop it.
    const same = nudgeSeen.key ? n.options.find((o) => o.key === nudgeSeen.key) : null;
    nudgeSeen.serial = n.serial;
    nudgeSeen.id = same ? same.id : '';
    nudgeSeen.key = same ? same.key : '';
    box.replaceChildren(...n.options.map((o) => {
      const b = document.createElement('button');
      b.dataset.id = o.id;
      b.addEventListener('click', () => { nudgeSeen.id = o.id; nudgeSeen.key = o.key; markNudge(); });
      return b;
    }));
  }
  for (const b of box.children) {
    const o = n.options.find((x) => x.id === b.dataset.id);
    const text = o.id + ': ' + o.label;
    if (b.textContent !== text) b.textContent = text;
  }
  nudgeSeen.brain = n.brain;
  markNudge();
  const held = t.kind === 'hold' || t.kind === 'asleep';
  note.textContent = held
    ? 'The reflex owns this moment or she is asleep (' + (t.why || t.kind) + '). "Do it now" will be refused. "Just log it" still works on the last menu.'
    : 'Pick the option you would have chosen. This is the menu from ' + (t.at || 'her last turn') + '.';
}
async function sendNudge(mode){
  const msg = document.getElementById('nudge-msg');
  const why = document.getElementById('nudge-why');
  const missing = document.getElementById('nudge-missing');
  if (!nudgeSeen.id && !missing.value.trim()) { msg.className = 'warn'; msg.textContent = 'Pick an option, or say what is missing.'; return; }
  const buttons = [document.getElementById('nudge-now'), document.getElementById('nudge-log')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch('/api/nudge', {
      method: 'POST',
      headers: { 'x-mind': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ mode, turn: nudgeSeen.serial, pick: nudgeSeen.id || null, why: why.value, missing: missing.value }),
    });
    const j = await res.json().catch(() => ({}));
    msg.className = res.ok ? 'note ok' : 'warn';
    msg.textContent = j.message || (res.ok ? 'Done.' : 'Failed (' + res.status + ').');
    // Only a nudge that went through clears the form. A refusal keeps everything typed.
    if (res.ok) { why.value = ''; missing.value = ''; nudgeSeen.id = ''; nudgeSeen.key = ''; markNudge(); }
  } catch (err) {
    msg.className = 'warn';
    msg.textContent = 'Could not reach the bridge.';
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}
async function delLesson(id){
  await fetch('/api/lessons/delete?id=' + encodeURIComponent(id), { method: 'POST', headers: { 'x-mind': '1' } });
  tick();
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
      plan: planner.plan,
      planner: {
        model: PLANNER_MODEL,
        running: planner.running,
        pending: [...planner.pending],
        lastError: planner.lastError,
      },
      nudge: nudgeView(),
      nudges: nudgeCount,
      examples: EXAMPLES_ON,
      lessons: lessonView(),
      runsRecorded: store.runs.length,
      review: reviewNote,
    }));
  }
  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(statsSummary(stats)));
  }
  if (url.pathname === '/api/lessons/delete' && req.method === 'POST') {
    // A page on another site can send a bare POST to localhost. A custom header forces a
    // preflight that this server never answers, so only /mind itself can delete.
    if (req.headers['x-mind'] !== '1') {
      res.writeHead(403);
      return res.end();
    }
    const ok = deleteLesson(store, String(url.searchParams.get('id') || ''));
    if (ok) saveLessons();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }
  if (url.pathname === '/api/nudge' && req.method === 'POST') {
    return handleNudge(req, res).catch((err) => {
      log('error', `nudge: ${String(err && err.message || err).slice(0, 120)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, message: 'The bridge hit an error. Nothing was sent.' });
    });
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
