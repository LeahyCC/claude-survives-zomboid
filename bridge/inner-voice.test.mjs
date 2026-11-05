// The inner voice: the running summary of the run, idle thoughts, the pairing with the brain's order,
// the voice file text, and that the prompt is first person. Every model call is mocked.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCommentator, emptyStory, updateStory, summaryLines, voiceText, SYSTEM, userMessage, linesFromLog,
  MIN_GAP_MS, IDLE_MIN_MS, IDLE_MAX_MS, INNER_MEMORY, SUMMARY_LINES, SUMMARY_LINE_MAX,
} from './commentator.mjs';

const T0 = 1_000_000;
const base = { v: 2, dead: false, hp: 100, kills: 0, hoursAlive: 5, day: 1, hour: 10, bleeding: 0, weapon: 'none', zChasing: 0, zClose: 0, inBldg: null, outside: true };
const look = (extra = {}) => ({ ...base, ...extra });
const inside = (id) => ({ inBldg: { id }, outside: false });

function rig(opts = {}) {
  const clock = { t: T0 };
  const asked = [];
  const written = [];
  const voiced = [];
  let isBusy = false;
  let isActive = true;
  const c = createCommentator({
    ask: opts.ask || (async (req) => { asked.push(req); return { raw: `thought ${asked.length}`, ms: 5 }; }),
    busy: () => isBusy,
    active: () => isActive,
    write: (o) => { written.push(o); return true; },
    voice: (t) => { voiced.push(t); return true; },
    now: () => clock.t,
    rand: opts.rand || (() => 0),
  });
  return { c, clock, asked, written, voiced, setBusy: (b) => { isBusy = b; }, setActive: (a) => { isActive = a; } };
}

test('the voice speaks as her: first person, in his style, and never gives orders', () => {
  assert.match(SYSTEM, /first person/);
  assert.match(SYSTEM, /"I", "me", "my"/);
  assert.match(SYSTEM, /voice inside the head/);
  // His style, with examples, and no fixed opening: a template made every line read like a diary.
  assert.match(SYSTEM, /shitposting/);
  assert.match(SYSTEM, /Do not start every line the same way/);
  assert.match(SYSTEM, /never give orders/);
  assert.ok(!SYSTEM.includes(String.fromCharCode(0x2014)) && !SYSTEM.includes(String.fromCharCode(0x2013)));
  const msg = userMessage({ kind: 'order', action: 'ENTER house W', thought: 'I need to hide out before dark', text: 'x' }, [], look(), { summary: ['Alive 1 game hours.'], inner: [] });
  assert.match(msg, /SHE JUST CHOSE: ENTER house W\. Her own reasoning: "I need to hide out before dark"/);
  assert.match(msg, /HER RUN SO FAR:\nAlive 1 game hours\./);
  assert.match(userMessage({ kind: 'idle', text: '' }, [], look(), {}), /NOTHING JUST HAPPENED/);
});

test('the running summary is built from what the bridge knows', () => {
  let st = emptyStory();
  const hist = [
    { id: 'o1', result: 'done', why: 'took 3: Crowbar, Tin of beans, Bandage' },
    { id: 'o2', result: 'failed', why: 'locked' },
  ];
  st = updateStory(st, look({ hoursAlive: 5, day: 1, hour: 9 }), { run: 'r1', searched: 0 });
  st = updateStory(st, look({ hoursAlive: 6, hour: 10, weapon: 'Bat', ...inside('h1') }), { run: 'r1', searched: 1, history: hist, events: [{ kind: 'hpDrop' }, { kind: 'nearDeath' }, { kind: 'bleeding' }], plan: { goal: 'search two houses' } });
  st = updateStory(st, look({ hoursAlive: 7, hour: 11, weapon: 'Crowbar', hp: 12, kills: 3, ...inside('h2') }), { run: 'r1', searched: 2, history: hist, plan: { goal: 'search two houses' } });
  const text = summaryLines(st).join('\n');
  assert.match(text, /Alive 2 game hours \(day 1, 11:00\), 3 kills, now inside a building\./);
  assert.match(text, /Started with nothing in hand, now holding a Crowbar\./);
  assert.match(text, /Went into 2 buildings, searched 2\./);
  assert.match(text, /Found: Crowbar, Tin of beans, Bandage\./);
  assert.match(text, /Hurt: 1 big hits, bled 1 times, 1 close calls, lowest 12 HP\./);
  assert.match(text, /Plan: search two houses\./);
  // The finds are counted once even though the same history is sent every look.
  assert.equal(st.finds.length, 3);
});

test('the summary is capped to a few short lines whatever the run was', () => {
  let st = emptyStory();
  const long = 'x'.repeat(400);
  for (let i = 0; i < 80; i++) {
    st = updateStory(st, look({ hoursAlive: 5 + i, kills: i, weapon: `Weapon${i}`, ...inside(`h${i}`) }), {
      run: 'r1', searched: i, plan: { goal: long }, history: [{ id: `o${i}`, result: 'done', why: `took 1: ${long}` }],
      events: [{ kind: 'hpDrop' }, { kind: 'bleeding' }, { kind: 'nearDeath' }],
    });
  }
  const lines = summaryLines(st);
  assert.ok(lines.length <= SUMMARY_LINES);
  for (const l of lines) assert.ok(l.length <= SUMMARY_LINE_MAX, l);
  assert.ok(lines.join('\n').length <= SUMMARY_LINES * SUMMARY_LINE_MAX);
  assert.ok(st.houses.length <= 40 && st.finds.length <= 6);
});

test('a new run id wipes the summary and the voice memory; so does the hours counter going back', async () => {
  const r = rig();
  r.c.observe(look({ hoursAlive: 5, weapon: 'Bat' }), { run: 'r1', searched: 4 });
  r.clock.t += 1000;
  await r.c.order({ action: 'SEARCH', thought: 'look around' });
  assert.equal(r.c.inner.length, 1);
  assert.equal(r.c.story.searched, 4);
  assert.equal(r.c.story.startWeapon, 'Bat');

  r.c.observe(look({ hoursAlive: 8 }), { run: 'r2', searched: 0 });
  assert.equal(r.c.story.run, 'r2');
  assert.equal(r.c.story.searched, 0);
  assert.equal(r.c.story.startWeapon, 'none');
  assert.deepEqual(r.c.inner, []);
  r.clock.t += MIN_GAP_MS + 1000;
  await r.c.order({ action: 'WAIT', thought: '' });
  assert.ok(!/thought 1/.test(r.asked[1].user), 'the last character\'s lines are not sent');
  assert.ok(!/Bat/.test(r.asked[1].user));

  // No run id at all: the game's own counter going back is enough.
  r.c.observe(look({ hoursAlive: 20, kills: 6 }), {});
  r.c.observe(look({ hoursAlive: 0.2, kills: 0 }), {});
  assert.equal(r.c.story.kills, 0);
  assert.deepEqual(r.c.inner, []);
});

test('the voice remembers only its last 4 lines and sends them each call', async () => {
  const r = rig();
  r.c.observe(look(), { run: 'r1' });
  for (let i = 0; i < 6; i++) {
    r.clock.t += MIN_GAP_MS + 1000;
    await r.c.order({ action: `WAIT ${i}`, thought: '' });
  }
  assert.equal(r.c.inner.length, INNER_MEMORY);
  assert.deepEqual(r.c.inner, ['thought 3', 'thought 4', 'thought 5', 'thought 6']);
  const last = r.asked[5].user;
  assert.match(last, /- thought 2\n- thought 3\n- thought 4\n- thought 5/);
  assert.ok(!/thought 1\b/.test(last));
  assert.match(last, /HER RUN SO FAR:/);
});

test('a line pairs with the brain\'s order, and with the latest one when orders come faster', async () => {
  const r = rig();
  r.c.observe(look(), { run: 'r1' });
  r.clock.t += 1000;
  await r.c.order({ action: 'ENTER house W', thought: 'I need to hide out before dark' });
  assert.match(r.asked[0].user, /SHE JUST CHOSE: ENTER house W\. Her own reasoning: "I need to hide out before dark"/);
  assert.equal(r.written[0].action, 'ENTER house W');
  assert.equal(r.written[0].thought, 'I need to hide out before dark');
  assert.equal(r.c.lines[0].action, 'ENTER house W');
  assert.equal(r.voiced[0], 'ENTER house W "I need to hide out before dark" | thought 1');

  // Three orders inside the gap: only the newest is answered, and a bigger moment rides along.
  r.clock.t += 5000;
  r.c.order({ action: 'SEARCH', thought: 'first' });
  r.clock.t += 5000;
  r.c.order({ action: 'SECURE', thought: 'second' });
  r.c.observe(look({ kills: 2 }), { run: 'r1' });
  r.clock.t += 5000;
  r.c.order({ action: 'SLEEP', thought: 'third' });
  assert.equal(r.c.pending.filter((e) => e.kind === 'order').length, 1);
  assert.equal(r.asked.length, 1);
  r.clock.t += MIN_GAP_MS;
  await r.c.maybeRun();
  assert.match(r.asked[1].user, /SHE JUST CHOSE: SLEEP\. Her own reasoning: "third"/);
  assert.match(r.asked[1].user, /ALSO: She killed 2 zombies/);
  assert.ok(!/first|second/.test(r.asked[1].user.split('HER STATE')[0].split('SHE JUST CHOSE')[1]));
  assert.equal(r.written[1].action, 'SLEEP');
});

test('a death is still the line when an order is waiting too', async () => {
  const r = rig();
  r.c.observe(look(), { run: 'r1' });
  r.setBusy(true);
  r.clock.t += 1000;
  r.c.order({ action: 'ENTER house W', thought: 't' });
  r.c.death({ cause: 'zombie bite', hoursAlive: 9, startHours: 5, kills: 4 });
  r.setBusy(false);
  await r.c.maybeRun();
  assert.match(r.asked[0].user, /WHAT JUST HAPPENED: She died/);
  assert.match(r.asked[0].user, /ALSO: She chose ENTER house W/);
  assert.equal(r.written[0].action, '');
});

test('idle thoughts come 60 to 90 s after the last line while nothing happens', async () => {
  const r = rig({ rand: () => 0 });
  r.c.observe(look(), { run: 'r1' });
  r.clock.t += IDLE_MIN_MS - 1000;
  assert.equal(r.c.maybeRun(), null, 'not yet');
  r.clock.t += 1000;
  await r.c.maybeRun();
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0].user, /NOTHING JUST HAPPENED/);
  assert.equal(r.written[0].kind, 'idle');
  assert.equal(r.voiced[0], 'thought 1');
  // The next one is another 60 s on, and the 30 s minimum holds.
  r.clock.t += IDLE_MIN_MS - 1;
  assert.equal(r.c.maybeRun(), null);
  r.clock.t += 1;
  await r.c.maybeRun();
  assert.equal(r.asked.length, 2);

  // The longest wait is 90 s.
  const slow = rig({ rand: () => 0.999999 });
  slow.c.observe(look(), { run: 'r1' });
  slow.clock.t += IDLE_MAX_MS - 100;
  assert.equal(slow.c.maybeRun(), null);
  slow.clock.t += 100;
  await slow.c.maybeRun();
  assert.equal(slow.asked.length, 1);
});

test('idle thoughts wait out events, a busy model and a game that is not running', async () => {
  const r = rig();
  r.c.observe(look(), { run: 'r1' });
  // An event just spoken pushes the next idle thought a full gap away.
  r.clock.t += 50_000;
  await r.c.observe(look({ kills: 1 }), { run: 'r1' });
  assert.equal(r.asked.length, 1);
  r.clock.t += IDLE_MIN_MS - 1;
  assert.equal(r.c.maybeRun(), null);

  r.clock.t += 2;
  r.setBusy(true);
  assert.equal(r.c.maybeRun(), null, 'never while a menu turn or plan waits on Ollama');
  r.setBusy(false);
  r.setActive(false);
  assert.equal(r.c.maybeRun(), null, 'no percepts coming in');
  r.setActive(true);
  await r.c.maybeRun();
  assert.equal(r.asked.length, 2);

  // Dead: nothing to think about.
  const d = rig();
  d.c.observe(look(), { run: 'r1' });
  d.c.observe({ dead: true }, { run: 'r1' });
  d.clock.t += 5 * IDLE_MAX_MS;
  assert.equal(d.c.maybeRun(), null);
});

test('a menu turn cutting an idle thought keeps nothing queued and does not use the turn', async () => {
  let calls = 0;
  const r = rig({ ask: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('comment cut short'), { preempted: true }); return { raw: 'back again', ms: 1 }; } });
  r.c.observe(look(), { run: 'r1' });
  r.clock.t += IDLE_MIN_MS;
  await r.c.maybeRun();
  assert.equal(r.written.length, 0);
  assert.equal(r.c.pending.length, 0);
  assert.equal(r.c.lastError, '');
  await r.c.maybeRun();
  assert.equal(calls, 2, 'still due, so it goes again once the model is free');
});

test('the voice file line carries both halves and stays one line', () => {
  assert.equal(voiceText({ action: 'ENTER house W', thought: 'I need to hide out before dark', line: "I'm feeling tense." }), 'ENTER house W "I need to hide out before dark" | I\'m feeling tense.');
  assert.equal(voiceText({ action: '', thought: '', line: 'just a thought' }), 'just a thought');
  const messy = voiceText({ action: 'GOTO 1,2', thought: 'a | b\nc', line: 'x\r\ny | z' });
  assert.ok(!/\n|\r/.test(messy));
  assert.equal(messy.split(' | ').length, 2, 'only the one separator is a pipe');
});

test('the panel rows and the log keep the action and the thought after a restart', async () => {
  const r = rig();
  r.c.observe(look(), { run: 'r1' });
  r.clock.t += 1000;
  await r.c.order({ action: 'SEARCH', thought: 'check the drawers' });
  const row = linesFromLog(r.written)[0];
  assert.equal(row.action, 'SEARCH');
  assert.equal(row.thought, 'check the drawers');
  const view = r.c.view().lines[0];
  assert.equal(view.action, 'SEARCH');
  assert.equal(view.thought, 'check the drawers');
});

test('nothing the voice says or remembers reaches the brain, the planner or the order line', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['brain.mjs', 'planner.mjs', 'policy.mjs', 'options.mjs', 'reactions.mjs', 'decisions.mjs', 'memory.mjs', 'digest.mjs']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/commentator|local_voice|pepe\.log|voiceText|\.inner\b/.test(src), `${f} must not read the voice`);
  }
  const bridge = fs.readFileSync(path.join(dir, 'pz-bridge.mjs'), 'utf8');
  // The one call into the voice from the order path hands it a copy and uses nothing back.
  const calls = bridge.split('\n').filter((l) => /pepe\.order\(/.test(l));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\s*pepe\.order\(\{ action: lastAction, thought: lastThought \}\);$/);
  assert.ok(!/=\s*pepe\.order|\(\s*pepe\.order/.test(bridge));
  // The file sits beside local_intent.txt, in the same folder.
  assert.match(bridge, /VOICE_FILE = path\.join\(LUA_DIR, 'local_voice\.txt'\)/);
  assert.ok(!/voice[^\n]*orderLine|orderLine[^\n]*voice/i.test(bridge));
});
