// The planner: when it asks, what it accepts back, and that it waits for the model.
// Every model call is mocked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture } from './fixtures/load.mjs';
import { emptyMemory } from './memory.mjs';
import { buildOptions } from './options.mjs';
import { planTurn, userMessage } from './brain.mjs';
import { callChoice, callPlanner, tacticalBusy, thinkRefused, PLAN_GRACE_MS } from './llm.mjs';
import {
  crossedHour, emptyWatch, detectEvents, parsePlan, planLines, planSchema, planPrompt, knownBuildings,
  createPlanner, MIN_GAP_MS, MAX_STEPS, INTERVAL_HOURS,
} from './planner.mjs';

const NOW = 1_000_000;
const quiet = { zList: [], zChasing: 0, zClose: 0, zDist: -1 };
const at = (hour, hours, extra = {}) => ({ v: 2, dead: false, hour, hoursAlive: hours, day: Math.floor(hours / 24), x: 0, y: 0, ...quiet, ...extra });

// Walk a list of looks through detectEvents the way the bridge does.
function walk(looks, mem = emptyMemory()) {
  let watch = emptyWatch();
  return looks.map((p) => {
    const r = detectEvents(watch, p, mem);
    watch = r.watch;
    return r.events;
  });
}

test('crossedHour handles the midnight wrap and skips', () => {
  assert.equal(crossedHour(5, 6, 6), true);
  assert.equal(crossedHour(6, 7, 6), false, 'already past it');
  assert.equal(crossedHour(17, 19, 18), true);
  assert.equal(crossedHour(23, 1, 6), false);
  assert.equal(crossedHour(22, 7, 6), true, 'a night slept through');
  assert.equal(crossedHour(8, 8, 8), false, 'no time passed');
});

test('start fires on the first live look, and again for a new character', () => {
  const runs = walk([at(9, 5), at(9, 5.1), at(9, 1), at(9, 1.2)]);
  assert.deepEqual(runs, [['start'], [], ['start'], []]);
});

test('dead resets the watch, so the next live look is a start', () => {
  const mem = emptyMemory();
  const watch = detectEvents(emptyWatch(), at(9, 5), mem).watch;
  assert.equal(watch.live, true);
  const dead = detectEvents(watch, { dead: true }, mem);
  assert.deepEqual(dead.events, []);
  assert.equal(dead.watch.live, false);
  assert.deepEqual(detectEvents(dead.watch, at(9, 6), mem).events, ['start']);
  assert.deepEqual(detectEvents(emptyWatch(), null, mem).events, []);
});

test('dawn and dusk fire once as the hour crosses 06:00 and 18:00', () => {
  const runs = walk([at(4, 20.0), at(5, 20.5), at(6, 21.0), at(6, 21.2), at(17, 21.4), at(18, 21.5), at(19, 21.8)]);
  assert.deepEqual(runs[2], ['dawn']);
  assert.deepEqual(runs[3], []);
  assert.deepEqual(runs[5], ['dusk']);
  assert.deepEqual(runs[6], []);
});

test('a building searched and a safehouse found each fire once', () => {
  const mem = emptyMemory();
  const b = { id: '1', visited: true, searched: false, res: true, water: false, bed: false, zombies: 0 };
  mem.buildings['1'] = b;
  let watch = detectEvents(emptyWatch(), at(9, 5), mem).watch;
  b.searched = true;
  let r = detectEvents(watch, at(9, 5.1), mem);
  assert.deepEqual(r.events, ['searched']);
  watch = r.watch;
  assert.deepEqual(detectEvents(watch, at(9, 5.2), mem).events, [], 'the same count is not news');
  // A searched residence with water and a bed scores 7: a safe house. Searched is already counted.
  b.water = true;
  b.bed = true;
  r = detectEvents(watch, at(9, 5.3), mem);
  assert.deepEqual(r.events, ['safehouse']);
  mem.buildings['2'] = { id: '2', searched: true, res: false, zombies: 0 };
  assert.deepEqual(detectEvents(r.watch, at(9, 5.4), mem).events, ['searched']);
});

test('otherwise every 2 game hours, counted from the last event', () => {
  const runs = walk([at(9, 5), at(10, 6.9), at(11, 7.0), at(11, 8.9), at(12, 9.1)]);
  assert.deepEqual(runs, [['start'], [], ['interval'], [], ['interval']]);
  assert.equal(INTERVAL_HOURS, 2);
  // An event resets the 2 hour count, so dawn at 6 means no interval at 8.
  assert.deepEqual(walk([at(5, 4), at(6, 5), at(7, 6.9)]).map((e) => e.length), [1, 1, 0]);
});

test('a percept with no hoursAlive falls back to the day and hour', () => {
  const p = (day, hour) => ({ v: 2, dead: false, day, hour });
  assert.deepEqual(walk([p(1, 8), p(1, 9), p(1, 10)]), [['start'], [], ['interval']]);
});

test('parsePlan: a good plan, trimmed and checked', () => {
  const plan = parsePlan(JSON.stringify({
    goal: 'Search houses \u2014 then head home.',
    steps: ['Search the next house', 'Fill bottles | at the tap', 'Be home by dusk', 'a fourth step is cut'],
    home: '4033',
  }), ['4033', '4031']);
  assert.equal(plan.goal, 'Search houses , then head home.');
  assert.equal(plan.steps.length, MAX_STEPS);
  assert.equal(plan.steps[1], 'Fill bottles at the tap');
  assert.equal(plan.home, '4033');
});

test('parsePlan: an unknown home is dropped, a missing goal is an error', () => {
  assert.equal(parsePlan('{"goal":"Look for water.","steps":[],"home":"9999"}', ['4033']).home, '');
  assert.equal(parsePlan('{"goal":"Look for water.","steps":"nope"}', ['4033']).steps.length, 0);
  assert.equal(parsePlan('{"goal":"Look for water.","home":4033}', ['4033']).home, '4033', 'a number id still matches');
  assert.throws(() => parsePlan('{"steps":["a"],"home":""}', []), /no goal/);
  assert.throws(() => parsePlan('{"goal":"  "}', []), /no goal/);
  assert.throws(() => parsePlan('thinking out loud, no JSON', []));
  const long = parsePlan(JSON.stringify({ goal: 'g'.repeat(500), steps: ['s'.repeat(500)], home: '' }), []);
  assert.equal(long.goal.length, 90);
  assert.equal(long.steps[0].length, 80);
});

test('plan schema matches what parsePlan allows', () => {
  const s = planSchema();
  assert.deepEqual(s.required, ['goal', 'steps', 'home']);
  assert.equal(s.properties.steps.maxItems, 3);
});

test('planLines is one or two short lines', () => {
  assert.equal(planLines(null), '');
  assert.equal(planLines({ goal: 'Find water.', steps: [], home: '' }), 'PLAN: Find water.');
  const two = planLines({ goal: 'Find water.', steps: ['Search two houses', 'Go home'], home: '4033' });
  assert.equal(two, 'PLAN: Find water. (home: building 4033)\nNEXT: Search two houses; Go home');
  assert.equal(two.split('\n').length, 2);
});

test('the prompt lists known buildings, the last plan, lessons and why now', () => {
  const { percept, memory } = loadFixture('v2-night-tired-bed.json');
  const text = planPrompt({
    p: percept, mem: memory, reasons: ['dusk', 'searched'],
    plan: { goal: 'Look for a bag.', steps: ['Search north'], home: '4033' },
    lessons: [{ when: 'night', text: 'Be inside before dark.' }],
  });
  assert.match(text, /WHY NOW: dusk, searched\./);
  assert.match(text, /KNOWN BUILDINGS:\n4033: house/);
  assert.match(text, /LAST PLAN: Look for a bag\. \(Search north\) Home: 4033\./);
  assert.match(text, /\(night\) Be inside before dark\./);
  const known = knownBuildings(memory, percept);
  assert.equal(known[0].id, '4033', 'the best home first');
});

function fakeAsk(replies) {
  const calls = [];
  const ask = async (req) => {
    calls.push(req);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { raw: next, ms: 1500 };
  };
  return { ask, calls };
}

const GOOD = JSON.stringify({ goal: 'Search houses, home by dusk.', steps: ['Search the next house'], home: '4021' });

function setup(overrides = {}) {
  const { percept, memory } = loadFixture('v2-day-searched-house.json');
  const p = { ...percept, ...quiet };
  const clock = { t: NOW };
  const logs = [];
  const fake = fakeAsk(overrides.replies || [GOOD]);
  const planner = createPlanner({
    ask: fake.ask,
    busy: overrides.busy || (() => false),
    lessons: () => [],
    now: () => clock.t,
    log: (kind, text) => logs.push([kind, text]),
    onChange: () => {},
  });
  return { planner, p, memory, clock, logs, fake };
}

test('the planner asks on start, stores a checked plan, and stays quiet after', async () => {
  const { planner, p, memory, logs, fake } = setup({ replies: [JSON.stringify({ goal: 'Find water.', steps: ['Search north'], home: 'not-a-building' })] });
  await planner.tick(p, memory);
  assert.equal(fake.calls.length, 1);
  assert.equal(planner.plan.goal, 'Find water.');
  assert.equal(planner.plan.home, '', 'an unknown home is dropped');
  assert.equal(planner.plan.why, 'start');
  assert.equal(planner.plan.ms, 1500);
  assert.equal(planner.running, false);
  assert.equal(planner.pending.size, 0);
  assert.ok(logs.some(([k]) => k === 'plan'));
  assert.equal(planner.tick(p, memory), null, 'no new event, no new call');
});

test('a known building id is kept as home', async () => {
  const { planner, p, memory } = setup();
  await planner.tick(p, memory);
  assert.equal(planner.plan.home, '4021');
});

test('a tactical turn on the model goes first: the planner waits for a free model', async () => {
  let busy = true;
  const { planner, p, memory, fake } = setup({ busy: () => busy });
  assert.equal(planner.tick(p, memory), null);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual([...planner.pending], ['start'], 'the event is kept, not lost');
  busy = false;
  await planner.tick(p, memory);
  assert.equal(fake.calls.length, 1);
  assert.equal(planner.plan.goal, 'Search houses, home by dusk.');
});

test('the planner does not plan in the middle of a fight', async () => {
  const { planner, p, memory, fake } = setup();
  const chased = { ...p, zChasing: 1, zList: [{ dx: 5, dy: 0, d: 5, chase: true }] };
  assert.equal(planner.tick(chased, memory), null);
  assert.equal(fake.calls.length, 0);
  await planner.tick(p, memory);
  assert.equal(fake.calls.length, 1);
});

test('only one plan runs at a time, and a later event waits its turn', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const clock = { t: NOW };
  const planner = createPlanner({
    ask: async (req) => { calls.push(req); await gate; return { raw: GOOD, ms: 1 }; },
    now: () => clock.t,
  });
  const { percept, memory } = loadFixture('v2-day-searched-house.json');
  const p = { ...percept, ...quiet };
  const first = planner.tick(p, memory);
  assert.ok(first);
  assert.equal(planner.running, true);
  clock.t += MIN_GAP_MS * 10;
  assert.equal(planner.tick({ ...p, hour: 17, hoursAlive: p.hoursAlive + 2.5 }, memory), null, 'busy planning');
  release();
  await first;
  assert.equal(calls.length, 1);
  assert.equal(planner.running, false);
  assert.ok(planner.pending.has('interval'), 'the second event is still waiting');
});

test('two events within 30 seconds make one plan', async () => {
  const { planner, p, memory, clock, fake } = setup({ replies: [GOOD, GOOD] });
  await planner.tick(p, memory);
  const later = { ...p, hour: 18, hoursAlive: p.hoursAlive + 0.5 };
  clock.t += 5_000;
  assert.equal(planner.tick(later, memory), null, 'dusk is too soon after the last plan');
  assert.ok(planner.pending.has('dusk'));
  clock.t += MIN_GAP_MS;
  await planner.tick(later, memory);
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[1].user, /WHY NOW: dusk\./);
});

test('a bad reply is logged and retried after the gap, and let go after 3 tries', async () => {
  const { planner, p, memory, clock, logs, fake } = setup({ replies: ['not json', new Error('ollama 500: boom'), '{"steps":[]}', GOOD] });
  await planner.tick(p, memory);
  assert.equal(planner.plan, null);
  assert.match(planner.lastError, /JSON/);
  assert.equal(planner.tick(p, memory), null, 'backs off for 30 seconds');
  clock.t += MIN_GAP_MS;
  await planner.tick(p, memory);
  assert.match(planner.lastError, /boom/);
  clock.t += MIN_GAP_MS;
  await planner.tick(p, memory);
  assert.equal(planner.pending.size, 0, 'after 3 failures the event is let go');
  assert.equal(fake.calls.length, 3);
  assert.equal(logs.filter(([k]) => k === 'error').length, 3);
  clock.t += MIN_GAP_MS;
  assert.equal(planner.tick(p, memory), null, 'nothing pending, no call');
});

test('reset forgets the plan, and the next live look plans again', async () => {
  const { planner, p, memory, clock, fake } = setup({ replies: [GOOD, GOOD] });
  await planner.tick(p, memory);
  planner.reset();
  assert.equal(planner.plan, null);
  clock.t += MIN_GAP_MS;
  await planner.tick(p, memory);
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[1].user, /WHY NOW: start\./);
  assert.doesNotMatch(fake.calls[1].user, /LAST PLAN/);
});

test('the plan goes into the tactical message as one or two lines', () => {
  const { percept, memory } = loadFixture('v2-outside-unaware-near.json');
  const plan = { goal: 'Search houses, home by dusk.', steps: ['Search the next house', 'Fill bottles'], home: '' };
  const withPlan = planTurn(percept, memory, { now: NOW, plan });
  assert.equal(withPlan.kind, 'ask');
  assert.match(withPlan.user, /\nPLAN: Search houses, home by dusk\.\nNEXT: Search the next house; Fill bottles\n/);
  assert.doesNotMatch(planTurn(percept, memory, { now: NOW }).user, /PLAN:/);
});

test('lessons whose trigger holds go in next to the rules, at most 3', () => {
  const { percept, memory } = loadFixture('v2-outside-unaware-near.json');
  const lessons = ['one', 'two', 'three', 'four'].map((w, i) => ({ id: `x${i}`, when: 'outside', text: `Lesson number ${w} applies.`, created: i, runs: 0 }));
  lessons.push({ id: 'y', when: 'bleeding', text: 'Bandage first, always, please.', created: 9, runs: 0 });
  const plan = planTurn(percept, memory, { now: NOW, lessons });
  assert.equal(plan.lessons.length, 3);
  assert.deepEqual(plan.lessons.map((l) => l.id), ['x3', 'x2', 'x1']);
  const rulesBlock = plan.user.split('\n\n').find((s) => s.startsWith('RULES FOR NOW:'));
  assert.equal((rulesBlock.match(/Lesson from a past run:/g) || []).length, 3);
  assert.doesNotMatch(plan.user, /Bandage first/);
  // Lessons alone still make a rules block.
  const alone = userMessage(percept, memory, [{ id: 'wait', label: 'wait here' }], [], [], [], { lessons: [lessons[0]] });
  assert.match(alone, /RULES FOR NOW:\n- Lesson from a past run: Lesson number one applies\./);
});

test('the planned home leads the menu at dusk, and at night, but not at noon', () => {
  const { percept, memory } = loadFixture('v2-night-outside.json');
  const plan = { goal: 'Home by dusk.', steps: [], home: '4061' };
  const first = (p, withPlan) => buildOptions(p, memory, { now: NOW, plan: withPlan }).filter((o) => o.verb === 'ENTER')[0];
  assert.equal(first(percept, null).target, '4060', 'the nearer house without a plan');
  const night = first(percept, plan);
  assert.equal(night.target, '4061');
  assert.match(night.label, /your planned home/);
  const dusk = { ...percept, hour: 18, dark: false };
  assert.equal(first(dusk, plan).target, '4061');
  const noon = { ...percept, hour: 12, dark: false };
  assert.equal(first(noon, plan).target, '4060', 'by day the usual order holds');
  const tagged = buildOptions(noon, memory, { now: NOW, plan }).find((o) => o.target === '4061');
  assert.match(tagged.label, /your planned home/, 'but the model is told which one it is');
});

test('the planned home is kept when it would fall off the 3 building slots', () => {
  const { percept, memory } = loadFixture('v2-night-outside.json');
  const near = ['4060', '4062', '4063', '4064', '4065'].map((id, i) => ({
    id, d: 5 + i, dx: 0, dy: -(5 + i), res: true, shop: false, visited: false, door: { x: percept.x, y: percept.y - 5 - i },
  }));
  const far = { id: '4099', d: 30, dx: 0, dy: 30, res: true, shop: false, visited: false, door: { x: percept.x, y: percept.y + 30 } };
  const many = { ...percept, buildings: [...near, far] };
  const targets = (plan) => buildOptions(many, memory, { now: NOW, plan }).filter((o) => o.verb === 'ENTER').map((o) => o.target);
  assert.ok(!targets(undefined).includes('4099'));
  assert.equal(targets({ home: '4099' })[0], '4099');
});

function mockFetch(handler) {
  const bodies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return handler(body, bodies.length);
  };
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

const okReply = (content, thinking) => ({ ok: true, json: async () => ({ message: { content, thinking } }) });

test('callPlanner asks for thinking and a bigger budget, with its own model', async () => {
  const m = mockFetch(() => okReply('{"goal":"x"}', 'let me think'));
  try {
    const r = await callPlanner({ system: 'sys', user: 'usr', schema: planSchema(), model: 'think-model-a' });
    assert.equal(r.raw, '{"goal":"x"}');
    assert.equal(r.thought, true);
  } finally {
    m.restore();
  }
  const b = m.bodies[0];
  assert.equal(b.model, 'think-model-a');
  assert.equal(b.think, true);
  assert.ok(b.options.num_predict >= 1000);
  assert.deepEqual(b.format, planSchema());
  assert.equal(b.messages[0].content, 'sys');
});

test('callPlanner falls back once for a model that cannot think, and remembers', async () => {
  const m = mockFetch((body) => (body.think
    ? { ok: false, status: 400, text: async () => '{"error":"\\"plain-model\\" does not support thinking"}' }
    : okReply('{"goal":"y"}')));
  try {
    const r = await callPlanner({ system: 's', user: 'u', schema: planSchema(), model: 'plain-model' });
    assert.equal(r.raw, '{"goal":"y"}');
    assert.equal(r.think, false);
    await callPlanner({ system: 's', user: 'u', schema: planSchema(), model: 'plain-model' });
  } finally {
    m.restore();
  }
  assert.deepEqual(m.bodies.map((b) => b.think), [true, false, false]);
});

test('callPlanner does not mistake other errors for a thinking refusal, and never returns thinking text', async () => {
  assert.equal(thinkRefused('ollama 400: model does not support thinking'), true);
  assert.equal(thinkRefused('ollama 500: out of memory'), false);
  let m = mockFetch(() => ({ ok: false, status: 500, text: async () => 'out of memory' }));
  try {
    await assert.rejects(callPlanner({ system: 's', user: 'u', schema: planSchema(), model: 'm-err' }), /500/);
  } finally {
    m.restore();
  }
  assert.equal(m.bodies.length, 1, 'no second try on a real error');
  m = mockFetch(() => okReply('', 'only reasoning came back'));
  try {
    await assert.rejects(callPlanner({ system: 's', user: 'u', schema: planSchema(), model: 'm-empty' }), /empty reply/);
  } finally {
    m.restore();
  }
});

test('tacticalBusy is true while a menu turn is on the model, and clears after', async () => {
  let during;
  const ok = mockFetch(async () => {
    during = tacticalBusy();
    return okReply('{"thought":"ok","choice":"wait"}');
  });
  try {
    assert.equal(tacticalBusy(), false);
    await callChoice('turn', ['wait']);
    assert.equal(during, true);
    assert.equal(tacticalBusy(), false);
  } finally {
    ok.restore();
  }
  const failing = mockFetch(() => ({ ok: false, status: 500, text: async () => 'x' }));
  try {
    await assert.rejects(callChoice('turn', ['wait']));
  } finally {
    failing.restore();
  }
  assert.equal(tacticalBusy(), false, 'a failed call also clears it');
});

test('a menu turn cuts a plan short once the grace runs out', { timeout: PLAN_GRACE_MS + 10000 }, async () => {
  const real = globalThis.fetch;
  // The plan never answers on its own; only an abort ends it. The menu turn answers at once.
  globalThis.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    if (body.format && body.format.properties && body.format.properties.choice) {
      return Promise.resolve(okReply(JSON.stringify({ thought: 'go', choice: 'wait' })));
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  try {
    const t0 = Date.now();
    const plan = callPlanner({ system: 's', user: 'u', schema: planSchema(), model: 'slow-plan' });
    const turn = await callChoice('pick', ['wait']);
    assert.match(turn.raw, /wait/);
    await assert.rejects(plan, (err) => err.preempted === true);
    const took = Date.now() - t0;
    assert.ok(took >= PLAN_GRACE_MS - 50 && took < PLAN_GRACE_MS + 2000, `cut after ${took} ms`);
    assert.equal(tacticalBusy(), false);
  } finally {
    globalThis.fetch = real;
  }
});

test('a cut-short plan is not counted as a failure and keeps its events', async () => {
  const logs = [];
  const planner = createPlanner({
    ask: async () => { throw Object.assign(new Error('plan cut short by a menu turn'), { preempted: true }); },
    log: (kind, msg) => logs.push(`${kind}: ${msg}`),
  });
  planner.pending.add('dawn');
  await planner.run({}, emptyMemory(), ['dawn']);
  assert.equal(planner.failures, 0);
  assert.equal(planner.lastError, '');
  assert.ok(planner.pending.has('dawn'));
  assert.ok(logs.some((l) => /cut short/.test(l)));
});

test('a plan that ends inside the grace is not cut', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    if (body.format && body.format.properties && body.format.properties.choice) {
      return Promise.resolve(okReply(JSON.stringify({ thought: 'go', choice: 'wait' })));
    }
    return new Promise((resolve) => setTimeout(() => resolve(okReply(JSON.stringify({ goal: 'g', steps: ['a'], home: '', why: 'w' }))), 300));
  };
  try {
    const plan = callPlanner({ system: 's', user: 'u', schema: planSchema(), model: 'quick-plan' });
    await callChoice('pick', ['wait']);
    const r = await plan;
    assert.match(r.raw, /goal/);
  } finally {
    globalThis.fetch = real;
  }
});
