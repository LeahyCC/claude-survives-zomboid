// The peanut gallery: which moments it notices, how often it speaks, when it stays quiet, the
// switch-off on a missing model, the log cap, and that nothing it writes reaches the brain.
// Every model call is mocked.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectMoments, emptyWatch, createCommentator, cleanLine, stateText, userMessage, linesFromLog, SYSTEM,
  MIN_GAP_MS, EXPIRE_MS, LINE_MAX, PANEL_LINES,
} from './commentator.mjs';
import { createAppender, readLog } from './jsonl.mjs';
import { callCommentary, callChoice, commentBusy, pepeOptions, PEPE_GPU_LAYERS, DEFAULT_PEPE_MODEL, modelInstalled } from './llm.mjs';
import { loadFixture } from './fixtures/load.mjs';
import { planTurn, orderLine } from './brain.mjs';
import { planPrompt } from './planner.mjs';

const T0 = 1_000_000;
const base = { v: 2, dead: false, hp: 100, kills: 0, hoursAlive: 5, day: 1, hour: 10, bleeding: 0, weapon: 'none', zChasing: 0, zClose: 0, inBldg: null, outside: true };
const look = (extra = {}) => ({ ...base, ...extra });
const house = { id: 'h1' };

// Feed looks one by one the way the bridge does and collect the kinds of moment seen at each.
function walk(looks, ctx = () => ({})) {
  let watch = emptyWatch();
  return looks.map((p, i) => {
    const r = detectMoments(watch, p, { now: T0 + i * 1000, ...ctx(i) });
    watch = r.watch;
    return r.events.map((e) => e.kind);
  });
}

test('the first look and a new character say nothing about the past', () => {
  const runs = walk([look({ hp: 10, kills: 9 }), look({ hp: 10, kills: 9 }), look({ hp: 100, kills: 0, hoursAlive: 0.1 })]);
  assert.deepEqual(runs, [[], [], []]);
});

test('kills, damage, bleeding, a better weapon and entering a building are noticed', () => {
  const runs = walk([
    look(),
    look({ kills: 1 }),
    look({ kills: 1, hp: 80 }),
    look({ kills: 1, hp: 80, bleeding: 1 }),
    look({ kills: 1, hp: 80, bleeding: 1, weapon: 'Bat', weaponScore: 20 }),
    look({ kills: 1, hp: 80, bleeding: 1, weapon: 'Bat', weaponScore: 20, inBldg: house, outside: false }),
  ]);
  assert.deepEqual(runs, [[], ['kill'], ['hpDrop'], ['bleeding'], ['weapon'], ['entered']]);
});

test('small hp changes and a weapon that is not clearly better are not news', () => {
  const runs = walk([
    look({ weapon: 'Bat', weaponScore: 20 }),
    look({ weapon: 'Bat', weaponScore: 20, hp: 95 }),
    look({ weapon: 'Hammer', weaponScore: 22, hp: 95 }),
    look({ weapon: 'none', hp: 95 }),
  ]);
  assert.deepEqual(runs, [[], [], [], []]);
  const better = walk([look({ weapon: 'Bat', weaponScore: 20 }), look({ weapon: 'Crowbar', weaponScore: 30 })]);
  assert.deepEqual(better[1], ['weapon']);
});

test('near death fires once, and again only after she has recovered', () => {
  const runs = walk([look(), look({ hp: 24 }), look({ hp: 20 }), look({ hp: 60 }), look({ hp: 10 })]);
  assert.deepEqual(runs.map((r) => r.includes('nearDeath')), [false, true, false, false, true]);
});

test('a flee and re-enter loop fires once while it lasts', () => {
  const hist = (n) => Array.from({ length: n }, (_, i) => [
    { id: `a${i}`, at: T0 + i * 4000, key: 'AWAY', verb: 'GOTO', result: 'done' },
    { id: `e${i}`, at: T0 + i * 4000 + 1000, key: 'ENTER:h1', verb: 'ENTER', result: 'done' },
  ]).flat();
  const runs = walk([look(), look(), look(), look()], (i) => ({ history: i === 0 ? [] : i === 1 ? hist(1) : hist(2) }));
  assert.deepEqual(runs.map((r) => r.includes('loop')), [false, false, true, false]);
});

test('an order that fails, a building locked up, and a new plan are noticed once', () => {
  const sent = { id: 'o1', at: T0, verb: 'ENTER', name: 'ENTER house W', result: null };
  const failed = { ...sent, result: 'failed', why: 'zombie' };
  const sec = { id: 'o2', at: T0, verb: 'SECURE', name: 'SECURE', result: 'done' };
  const runs = walk([look(), look(), look(), look(), look(), look()], (i) => ({
    history: i === 0 ? [] : i === 1 ? [sent] : i === 2 ? [failed] : i === 3 ? [failed] : [failed, sec],
    plan: i >= 4 ? { at: 5, goal: 'search two houses' } : i === 0 ? { at: 1, goal: 'old' } : { at: 1, goal: 'old' },
  }));
  assert.deepEqual(runs, [[], [], ['failed'], [], ['secured', 'plan'], []]);
});

test('a dead percept resets the watch without events', () => {
  let r = detectMoments(emptyWatch(), look(), { now: T0 });
  r = detectMoments(r.watch, { dead: true }, { now: T0 + 1 });
  assert.equal(r.watch.live, false);
  assert.deepEqual(r.events, []);
});

// A commentator with a fake clock and a model that answers on demand.
function rig(opts = {}) {
  const clock = { t: T0 };
  const asked = [];
  const written = [];
  const logs = [];
  let isBusy = false;
  const c = createCommentator({
    ask: opts.ask || (async (req) => { asked.push(req); return { raw: `line ${asked.length}`, ms: 5 }; }),
    busy: () => isBusy,
    write: (o) => { written.push(o); return true; },
    now: () => clock.t,
    log: (k, t) => logs.push([k, t]),
    enabled: opts.enabled,
    lines: opts.lines,
  });
  return { c, clock, asked, written, logs, setBusy: (b) => { isBusy = b; } };
}
const nextKill = (c, kills, extra = {}) => c.observe(look({ kills, ...extra }), {});

test('at most one line every 30 seconds, and the heaviest moment is the one spoken', async () => {
  const r = rig();
  r.c.observe(look(), {});
  r.clock.t += 1000;
  await nextKill(r.c, 1);
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0].user, /killed a zombie/);

  // Inside the gap: a kill and a bigger hit both wait.
  r.clock.t += 5000;
  r.c.observe(look({ kills: 2 }), {});
  r.clock.t += 5000;
  assert.equal(r.c.observe(look({ kills: 2, hp: 50 }), {}), null);
  assert.equal(r.asked.length, 1);

  // Past the gap and past the point where those two are still worth saying.
  r.clock.t += EXPIRE_MS + 1000;
  assert.equal(r.c.maybeRun(), null, 'stale moments are dropped');
  assert.equal(r.asked.length, 1);

  r.c.observe(look({ kills: 2, hp: 50 }), {});
  r.clock.t += 100;
  r.c.observe(look({ kills: 3, hp: 20 }), {});
  await r.c.maybeRun();
  assert.equal(r.asked.length, 2);
  // Two moments landed together: the near-death one outranks the damage and the kill, and the others ride along.
  assert.match(r.asked[1].user, /WHAT JUST HAPPENED: She is nearly dead/);
  assert.match(r.asked[1].user, /ALSO: /);
  assert.equal(r.written.length, 2);
});

test('death is spoken at once, even inside the gap, and waits through a busy model', async () => {
  const r = rig();
  r.c.observe(look(), {});
  r.clock.t += 1000;
  await nextKill(r.c, 1);
  r.clock.t += 1000;
  r.setBusy(true);
  assert.equal(r.c.death({ cause: 'zombie bite', hoursAlive: 9, startHours: 5, kills: 4 }), null, 'busy: waits');
  assert.equal(r.asked.length, 1);
  r.clock.t += EXPIRE_MS + 1000;
  r.setBusy(false);
  await r.c.maybeRun();
  assert.equal(r.asked.length, 2, 'a death does not go stale like other moments');
  assert.match(r.asked[1].user, /She died \(zombie bite\) after 4 game hours and 4 kills/);
});

test('it never asks while the model is busy, and asks once it is free', async () => {
  const r = rig();
  r.c.observe(look(), {});
  r.setBusy(true);
  r.clock.t += 1000;
  assert.equal(r.c.observe(look({ kills: 1 }), {}), null);
  assert.equal(r.asked.length, 0);
  r.clock.t += 5000;
  r.setBusy(false);
  await r.c.maybeRun();
  assert.equal(r.asked.length, 1);
});

test('one line at a time: moments during a comment are skipped, not queued behind it', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const asked = [];
  const r = rig({ ask: async (req) => { asked.push(req); await gate; return { raw: 'slow one', ms: 1 }; } });
  r.c.observe(look(), {});
  r.clock.t += 1000;
  const first = nextKill(r.c, 1);
  assert.ok(first);
  assert.equal(r.c.running, true);
  r.clock.t += MIN_GAP_MS + 1000;
  assert.equal(r.c.observe(look({ kills: 2 }), {}), null, 'a comment is being written');
  release();
  await first;
  assert.equal(asked.length, 1);
});

test('a comment cut short by a menu turn keeps its moment and does not use the turn', async () => {
  let calls = 0;
  const r = rig({ ask: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('comment cut short'), { preempted: true }); return { raw: 'second try', ms: 1 }; } });
  r.c.observe(look(), {});
  r.clock.t += 1000;
  await nextKill(r.c, 1);
  assert.equal(r.written.length, 0);
  assert.equal(r.c.lines.length, 0);
  assert.equal(r.c.lastError, '');
  await r.c.maybeRun();
  assert.equal(calls, 2, 'asked again straight away, no 30 second wait');
  assert.equal(r.written.length, 1);
});

test('a missing model (404) turns it off with one log line and no more calls', async () => {
  const r = rig({ ask: async () => { throw new Error(`ollama 404: {"error":"model 'pepe' not found"}`); } });
  r.c.observe(look(), {});
  r.clock.t += 1000;
  await nextKill(r.c, 1);
  assert.equal(r.c.enabled, false);
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0][1], /not installed/);
  assert.equal(r.c.view().on, false);
  r.clock.t += 5 * MIN_GAP_MS;
  assert.equal(nextKill(r.c, 2), null);
  assert.equal(r.logs.length, 1);
});

test('other errors keep it on, wait out the gap, and log once per streak', async () => {
  let calls = 0;
  const r = rig({ ask: async () => { calls += 1; throw new Error('ollama 500: boom'); } });
  r.c.observe(look(), {});
  r.clock.t += 1000;
  await nextKill(r.c, 1);
  r.clock.t += 2000;
  assert.equal(r.c.observe(look({ kills: 2 }), {}), null, 'a failure still uses the 30 second gap');
  r.clock.t += MIN_GAP_MS;
  await r.c.observe(look({ kills: 3 }), {});
  assert.equal(calls, 2);
  assert.equal(r.c.enabled, true);
  assert.equal(r.logs.length, 1);
  assert.equal(r.c.lastError, 'ollama 500: boom');
});

test('PZ_PEPE=0 style switch: disabled from the start never asks', () => {
  const r = rig({ enabled: false });
  r.c.observe(look(), {});
  assert.equal(nextKill(r.c, 1), null);
  assert.equal(r.c.death({ cause: 'x' }), null);
  assert.equal(r.asked.length, 0);
  assert.equal(r.c.view().on, false);
});

test('the reply is trimmed to length and stripped of control characters, nothing more', () => {
  assert.equal(cleanLine('a\u0000b\u001b[31mc\r\nd\te'), 'a b [31mc d e');
  assert.equal(cleanLine('x'.repeat(LINE_MAX + 50)).length, LINE_MAX);
  assert.equal(cleanLine('  lmao >she dead :) *gg* "ok"  '), 'lmao >she dead :) *gg* "ok"');
  assert.equal(cleanLine(null), '');
  assert.equal(cleanLine({}), '');
});

test('an empty reply writes nothing', async () => {
  const r = rig({ ask: async () => ({ raw: ' \u0000 ', ms: 1 }) });
  r.c.observe(look(), {});
  r.clock.t += 1000;
  await nextKill(r.c, 1);
  assert.equal(r.written.length, 0);
  assert.equal(r.c.lines.length, 0);
});

test('the panel keeps the last 10 lines, and rebuilds from the log after a restart', async () => {
  const r = rig();
  r.c.observe(look(), {});
  for (let i = 1; i <= 12; i++) {
    r.clock.t += MIN_GAP_MS + 1000;
    await nextKill(r.c, i);
  }
  assert.equal(r.c.view().lines.length, PANEL_LINES);
  assert.equal(r.c.view().lines[PANEL_LINES - 1].line, 'line 12');
  const rows = linesFromLog(r.written);
  assert.equal(rows.length, PANEL_LINES);
  const again = rig({ lines: rows });
  assert.equal(again.c.view().lines.length, PANEL_LINES);
  assert.equal(again.c.view().lines[0].line, 'line 3');
  assert.deepEqual(linesFromLog([{ nope: 1 }, null, { line: '' }, { line: 'ok', at: 'bad' }]).map((l) => l.line), ['ok']);
});

test('pepe.log is capped: it rolls to .1 and stays under twice the cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-pepe-'));
  try {
    const file = path.join(dir, 'pepe.log');
    const cap = 2000;
    const write = createAppender(file, { maxBytes: cap });
    for (let i = 0; i < 200; i++) write({ at: new Date(T0 + i).toISOString(), kind: 'kill', event: 'x'.repeat(40), line: `line ${i} ${'y'.repeat(30)}` });
    assert.ok(fs.statSync(file).size <= cap);
    assert.ok(fs.statSync(file + '.1').size <= cap);
    const back = readLog(file);
    assert.equal(back[back.length - 1].line.startsWith('line 199'), true);
    assert.equal(linesFromLog(back).length, PANEL_LINES);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt it sends is small and plain, and carries the state', () => {
  const p = look({ hp: 42, zChasing: 3, bleeding: 1, weapon: 'Bat', kills: 4, inBldg: house, outside: false });
  assert.match(stateText(p), /42\/100 HP, 3 zombies chasing her, bleeding, inside a building, holding a Bat, day 1, 4 kills/);
  const msg = userMessage({ text: 'She killed a zombie.' }, [{ text: 'She started bleeding.' }], p, 'previous');
  assert.match(msg, /WHAT JUST HAPPENED: She killed a zombie\./);
  assert.match(msg, /ALSO: She started bleeding\./);
  assert.match(msg, /YOUR LAST LINE \(do not repeat it\): previous/);
  assert.match(SYSTEM, /survivor in a zombie game/);
  assert.ok(!SYSTEM.includes(String.fromCharCode(0x2014)) && !SYSTEM.includes(String.fromCharCode(0x2013)));
});

// llm.mjs side, with fetch mocked.
function mockFetch(handler) {
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    bodies.push({ url: String(url), body });
    return handler(body, init, String(url));
  };
  return { bodies, restore: () => { globalThis.fetch = real; } };
}
const okReply = (content) => ({ ok: true, json: async () => ({ message: { content } }) });
// A reply that never comes until the request is aborted, like a slow generation.
const hang = (init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

test('a comment request runs on the CPU with the shared context, no thinking and a small budget', async (t) => {
  if (process.env.PZ_PEPE_GPU_LAYERS || process.env.PZ_PEPE_PREDICT || process.env.PZ_PEPE_MODEL) {
    t.skip('pepe env is set on this machine');
    return;
  }
  const m = mockFetch(() => okReply('hi'));
  try {
    const r = await callCommentary({ system: 's', user: 'u' });
    assert.equal(r.raw, 'hi');
  } finally {
    m.restore();
  }
  const b = m.bodies[0].body;
  assert.equal(b.model, DEFAULT_PEPE_MODEL);
  assert.equal(b.options.num_gpu, 0);
  assert.equal(PEPE_GPU_LAYERS, 0);
  assert.equal(b.think, false);
  assert.ok(b.options.num_predict <= 150);
  assert.equal(b.options.num_ctx, pepeOptions().num_ctx);
  const menu = mockFetch(() => okReply('{"thought":"t","choice":"a"}'));
  try {
    await callChoice('u', ['a']);
  } finally {
    menu.restore();
  }
  assert.equal(menu.bodies[0].body.options.num_ctx, b.options.num_ctx, 'same num_ctx, so Ollama does not reload');
});

test('a menu turn starting during a comment cuts it at once', async () => {
  const m = mockFetch((body, init) => (body.model === DEFAULT_PEPE_MODEL || body.options.num_gpu === 0 ? hang(init) : okReply('{"thought":"t","choice":"a"}')));
  try {
    const comment = callCommentary({ system: 's', user: 'u' });
    comment.catch(() => {});
    assert.equal(commentBusy(), true);
    await assert.rejects(() => callCommentary({ system: 's', user: 'u' }), /already being written/);
    const started = Date.now();
    await callChoice('u', ['a']);
    await assert.rejects(comment, (e) => e.preempted === true);
    assert.ok(Date.now() - started < 1000);
    assert.equal(commentBusy(), false);
  } finally {
    m.restore();
  }
});

test('a 404 from Ollama reaches the commentator as a missing model, not as a cut', async () => {
  const m = mockFetch(() => ({ ok: false, status: 404, text: async () => `{"error":"model 'pepe' not found"}` }));
  try {
    await assert.rejects(() => callCommentary({ system: 's', user: 'u' }), /404.*not found/s);
    assert.equal(commentBusy(), false);
  } finally {
    m.restore();
  }
});

test('modelInstalled reads the tag list and says null when Ollama cannot be asked', async () => {
  const tags = (names) => () => ({ ok: true, json: async () => ({ models: names.map((name) => ({ name, model: name })) }) });
  let m = mockFetch(tags(['gemma4:12b', DEFAULT_PEPE_MODEL]));
  try {
    assert.equal(await modelInstalled(DEFAULT_PEPE_MODEL), true);
    assert.equal(await modelInstalled('other-model'), false);
    assert.equal(await modelInstalled('gemma4'), false);
  } finally {
    m.restore();
  }
  m = mockFetch(() => { throw new Error('refused'); });
  try {
    assert.equal(await modelInstalled(), null);
  } finally {
    m.restore();
  }
});

// The wall between the gallery and the brain.
test('what the gallery writes never reaches the brain prompt, the plan prompt or the order line', async () => {
  const MARK = 'ZXQ-PEPE-MARKER-lmao';
  const r = rig({ ask: async () => ({ raw: MARK, ms: 1 }) });
  r.c.observe(look(), {});
  r.clock.t += 1000;
  await nextKill(r.c, 1);
  assert.equal(r.c.lines[0].line, MARK);

  const { percept, memory } = loadFixture('v2-night-outside.json');
  const plan = planTurn(percept, memory, { now: T0 });
  const option = (plan.options || []).find((o) => o.verb) || { verb: 'WAIT', label: 'wait' };
  const everything = JSON.stringify([
    plan.user, plan.rules, plan.options,
    orderLine(1, option, 'thought', 'say'),
    planPrompt({ p: percept, mem: memory, reasons: ['start'], plan: null, lessons: [] }),
  ]);
  assert.ok(!everything.includes(MARK));
});

test('only the bridge entry point imports the commentator, and it feeds nothing back to the brain', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const importers = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs') || f.endsWith('.test.mjs') || f === 'commentator.mjs') continue;
    if (/commentator\.mjs|callCommentary/.test(fs.readFileSync(path.join(dir, f), 'utf8'))) importers.push(f);
  }
  // llm.mjs defines callCommentary, tools/try-pepe.mjs is in a subfolder and is not scanned.
  assert.deepEqual(importers.sort(), ['llm.mjs', 'pz-bridge.mjs']);
  const bridge = fs.readFileSync(path.join(dir, 'pz-bridge.mjs'), 'utf8');
  // The only reads of the gallery's state are the /mind payload and the switch-off notice.
  const uses = bridge.split('\n').filter((l) => /(?<![\w'])pepe\.[a-zA-Z]+\(/.test(l)).map((l) => l.trim());
  for (const l of uses) assert.match(l, /pepe\.(observe|death|disable|maybeRun|view)\(/, l);
  assert.ok(!/planTurn\([^)]*pepe/s.test(bridge));
  assert.ok(!/state\.log\.push\([^)]*pepe/.test(bridge));
});

test('a reply cut mid-sentence is trimmed back to the last full sentence', () => {
  assert.equal(cleanLine('Still bleeding tho. Just took a hit with that bat and now she'), 'Still bleeding tho.');
  assert.equal(cleanLine('What a legend.'), 'What a legend.');
  assert.equal(cleanLine('no full stop anywhere here'), 'no full stop anywhere here');
});
