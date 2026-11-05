// The v2 brain on the fixtures: hold rule, options, policy, digest, schema, memory, playbook.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, readFixture, fixtureNames } from './fixtures/load.mjs';
import { holdReason, isV2, needs } from './senses.mjs';
import { buildOptions, MAX_OPTIONS, pathClear } from './options.mjs';
import { decidePolicy } from './policy.mjs';
import { digest } from './digest.mjs';
import { choiceSchema, parseChoice, SYSTEM, callChoice, KEEP_ALIVE } from './llm.mjs';
import { emptyMemory, loadMemory, updateMemory, recordOrder, securedThisVisit, safehouseScore, tookItems, memoryStats, blockedWhy } from './memory.mjs';
import { selectRules, MAX_RULES } from './playbook.mjs';
import { planTurn, resolveChoice, orderLine, snapshot, RECHECK_MS } from './brain.mjs';
import { compass, segmentDistance, awayFrom } from './geom.mjs';
import { partName, woundText, level } from './words.mjs';

const NOW = 1_000_000;
const ids = (opts) => opts.map((o) => o.id);
const byId = (opts, id) => opts.find((o) => o.id === id);
const targets = (opts) => opts.filter((o) => o.verb === 'ENTER').map((o) => o.target);

test('pure helpers', () => {
  assert.equal(compass(10, 0), 'E');
  assert.equal(compass(0, -10), 'N');
  assert.equal(compass(-7, 7), 'SW');
  assert.equal(segmentDistance(5, 3, 0, 0, 10, 0), 3);
  assert.equal(segmentDistance(-4, 0, 0, 0, 10, 0), 4);
  const away = awayFrom([{ dx: 7, dy: 0 }], 15);
  assert.deepEqual(away, { dx: -15, dy: 0 });
  assert.equal(partName('Hand_L'), 'left hand');
  assert.equal(partName('Torso_Upper'), 'chest');
  assert.equal(woundText({ part: 'ForeArm_R', scratch: true, bandaged: true }), 'scratch on the right forearm, bandaged');
  assert.equal(level(0.62), 'high');
  assert.equal(level(0.05), 'none');
});

test('every v2 fixture is v2, the old one is not', () => {
  for (const name of fixtureNames()) assert.ok(isV2(readFixture(name)), name);
  assert.equal(isV2(readFixture('v1-old-mod.json')), false);
});

test('hold only for a chaser inside 10 or anything inside 3', () => {
  assert.match(holdReason(readFixture('v2-outside-chased.json')), /chasing/);
  assert.match(holdReason(readFixture('v2-close-unaware.json')), /inside 3/);
  // An idle zombie 7 tiles off, which the old zClose rule went silent for.
  const idle = readFixture('v2-outside-unaware-near.json');
  assert.equal(idle.zClose, 1);
  assert.equal(holdReason(idle), '');
  // A chaser at 14 tiles is not the reflex's yet.
  assert.equal(holdReason({ ...idle, zList: [{ dx: 14, dy: 0, d: 14, chase: true }] }), '');
  // No zList: zChasing with something inside 10 holds.
  const noList = { ...idle, zList: undefined, zChasing: 1, zClose: 1, zDist: 8 };
  assert.match(holdReason(noList), /chasing/);
  assert.equal(holdReason({ ...noList, zChasing: 0 }), '');
  assert.equal(holdReason({ ...idle, dead: true }), '');
});

test('options walk around an idle zombie and never toward it', () => {
  const { percept, memory } = loadFixture('v2-outside-unaware-near.json');
  const opts = buildOptions(percept, memory, { now: NOW });
  // 4050's door is 13 tiles E, right past the zombie at 7 E. 4051 is the other way.
  assert.deepEqual(targets(opts), ['4051']);
  const away = byId(opts, 'away');
  assert.equal(away.verb, 'GOTO');
  assert.ok(away.a < percept.x, 'heads west, away from the zombie in the east');
  assert.match(away.label, /not seen you/);
  for (const o of opts.filter((x) => x.verb === 'GOTO')) {
    assert.ok(pathClear(o.a - percept.x, o.b - percept.y, [{ dx: 7, dy: -2 }]), o.id);
  }
});

test('options are legal, short, unique, and end in wait or keep', () => {
  for (const name of fixtureNames()) {
    const { percept, memory } = loadFixture(name);
    const opts = buildOptions(percept, memory, { now: NOW });
    if (percept.dead) continue;
    assert.ok(opts.length <= MAX_OPTIONS, name);
    assert.equal(new Set(ids(opts)).size, opts.length, name);
    assert.ok(['wait', 'keep'].includes(opts[opts.length - 1].id), name);
    for (const o of opts) assert.ok(o.label && o.label.length < 120, `${name} ${o.id}`);
    if (percept.outside) assert.equal(byId(opts, 'search'), undefined, `${name}: no search outside`);
  }
});

test('no drink without water, no sleep with a chaser, no search when searched', () => {
  const { percept, memory } = loadFixture('v2-night-outside.json');
  const dry = { ...percept, thirst: 0.7, moodle: { ...percept.moodle, thirsty: 2 }, inv: { ...percept.inv, waterL: 0 } };
  assert.equal(byId(buildOptions(dry, memory, { now: NOW }), 'drink'), undefined);
  assert.ok(byId(buildOptions({ ...dry, inv: percept.inv }, memory, { now: NOW }), 'drink'));

  const bed = loadFixture('v2-night-tired-bed.json');
  assert.ok(byId(buildOptions(bed.percept, bed.memory, { now: NOW }), 'sleep'));
  const chased = { ...bed.percept, zChasing: 1, zList: [{ dx: 14, dy: 0, d: 14, chase: true }] };
  assert.equal(byId(buildOptions(chased, bed.memory, { now: NOW }), 'sleep'), undefined);
  const awake = { ...bed.percept, fatigue: 0.2, moodle: { ...bed.percept.moodle, tired: 0 } };
  assert.equal(byId(buildOptions(awake, bed.memory, { now: NOW }), 'sleep'), undefined);

  const done = loadFixture('v2-day-searched-house.json');
  const opts = buildOptions(done.percept, done.memory, { now: NOW });
  assert.equal(byId(opts, 'search'), undefined);
  assert.ok(byId(opts, 'wearbag'), 'a duffel bag is carried, none worn');
  assert.match(byId(opts, 'b1').label, /not visited/);
});

test('a running job is offered as keep, not again', () => {
  const { percept, memory } = loadFixture('v2-searching.json');
  const opts = buildOptions(percept, memory, { now: NOW });
  assert.equal(opts[opts.length - 1].id, 'keep');
  assert.equal(byId(opts, 'search'), undefined);
  assert.equal(byId(opts, 'wait'), undefined, 'a WAIT would drop a needs job');
  // Equip or a new house would cancel the search. Only urgent needs may.
  assert.deepEqual(ids(opts), ['keep']);
  const thirsty = { ...percept, thirst: 0.5, moodle: { ...percept.moodle, thirsty: 1 } };
  assert.deepEqual(ids(buildOptions(thirsty, memory, { now: NOW })), ['drink', 'keep']);
  // A walk to a house may change its mind about which house.
  const walking = { ...readFixture('v2-night-outside.json'), res: { seq: 70, verb: 'ENTER', status: 'running', why: '' } };
  recordOrder(memory, 70, { verb: 'ENTER', key: 'ENTER:4060' }, walking);
  updateMemory(memory, walking, NOW);
  assert.deepEqual(targets(buildOptions(walking, memory, { now: NOW })), ['4061']);
});

test('a failed order is not resent straight away', () => {
  const { percept, memory } = loadFixture('v2-day-searched-house.json');
  recordOrder(memory, 31, { verb: 'ENTER', key: 'ENTER:4022' }, percept);
  updateMemory(memory, { ...percept, res: { seq: 31, status: 'failed', verb: 'ENTER', why: 'stuck' } }, NOW);
  assert.equal(blockedWhy(memory, 'ENTER:4022', NOW + 1000), 'stuck');
  assert.ok(!targets(buildOptions(percept, memory, { now: NOW + 1000 })).includes('4022'));
  assert.ok(targets(buildOptions(percept, memory, { now: NOW + 61_000 })).includes('4022'));
  // A locked house stays off the menu much longer.
  recordOrder(memory, 32, { verb: 'ENTER', key: 'ENTER:4017' }, percept);
  updateMemory(memory, { ...percept, res: { seq: 32, status: 'failed', verb: 'ENTER', why: 'locked' } }, NOW);
  assert.ok(!targets(buildOptions(percept, memory, { now: NOW + 10 * 60_000 })).includes('4017'));
});

test('policy handles what cannot wait, and leaves the rest to the model', () => {
  const pick = (name) => {
    const { percept, memory } = loadFixture(name);
    return decidePolicy(percept, memory, buildOptions(percept, memory, { now: NOW }));
  };
  assert.equal(pick('v2-bleeding.json').option.verb, 'BANDAGE');
  assert.equal(pick('v2-indoors-thirsty-sink.json').option.verb, 'DRINK');
  const night = pick('v2-night-outside.json');
  assert.equal(night.rule, 'night-outside');
  assert.equal(night.option.verb, 'ENTER');
  assert.equal(night.option.target, '4060');
  assert.equal(pick('v2-night-tired-bed.json').option.verb, 'SECURE');
  assert.equal(pick('v2-day-searched-house.json'), null);
  assert.equal(pick('v2-outside-unaware-near.json'), null);
});

test('night inside: secure first, then sleep', () => {
  const { percept, memory } = loadFixture('v2-night-tired-bed.json');
  recordOrder(memory, 53, { verb: 'SECURE', key: 'SECURE:4033' }, percept);
  const after = { ...percept, res: { seq: 53, status: 'done', verb: 'SECURE', why: 'closed 2 doors' }, lastSeq: 53, hoursAlive: percept.hoursAlive + 0.2 };
  updateMemory(memory, after, NOW);
  assert.ok(securedThisVisit(memory, '4033'));
  const opts = buildOptions(after, memory, { now: NOW });
  assert.equal(byId(opts, 'secure'), undefined);
  assert.equal(decidePolicy(after, memory, opts).option.verb, 'SLEEP');
});

test('digest is short plain words, not JSON', () => {
  const { percept, memory } = loadFixture('v2-indoors-thirsty-sink.json');
  const text = digest(percept, memoryStats(memory));
  assert.match(text, /Thirst high/);
  assert.match(text, /No water carried, a tap 3 tiles away in this building/);
  assert.match(text, /Nothing in hand, a Kitchen Knife in the bag/);
  assert.equal(text.includes('{'), false);
  assert.ok(text.split('\n').length <= 9);
  const chased = digest(readFixture('v2-outside-chased.json'));
  assert.match(chased, /2 chasing you, nearest 9 tiles SW/);
  assert.match(chased, /Panic some/, 'panic 46 of 100 reads as some, not critical');
  assert.match(digest(readFixture('v2-bleeding.json')), /bleeding and cut on the left hand/);
});

test('schema enum is exactly this turn\'s ids, thought first', () => {
  const s = choiceSchema(['b1', 'drink', 'wait']);
  assert.deepEqual(Object.keys(s.properties), ['thought', 'choice']);
  assert.deepEqual(s.properties.choice.enum, ['b1', 'drink', 'wait']);
  assert.deepEqual(s.required, ['thought', 'choice']);
  assert.deepEqual(parseChoice('{"thought":"Water.","choice":"drink"}', ['drink', 'wait']), { choice: 'drink', thought: 'Water.' });
  assert.throws(() => parseChoice('{"thought":"x","choice":"MOVE"}', ['drink', 'wait']), /not on the menu/);
  assert.throws(() => parseChoice('nope', ['wait']));
  assert.equal(parseChoice('{"thought":"a|b\\nc","choice":"wait"}', ['wait']).thought, 'a b c');
});

test('the system message never changes, so Ollama can reuse its cache', async () => {
  const bodies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ message: { content: '{"thought":"ok","choice":"wait"}' }, eval_count: 9 }) };
  };
  try {
    await callChoice('turn one', ['b1', 'wait']);
    await callChoice('turn two, different', ['drink', 'wait']);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(bodies[0].messages[0].role, 'system');
  assert.equal(bodies[0].messages[0].content, SYSTEM);
  assert.equal(bodies[1].messages[0].content, bodies[0].messages[0].content);
  assert.equal(bodies[1].messages[1].content, 'turn two, different');
  assert.deepEqual(bodies[1].format.properties.choice.enum, ['drink', 'wait']);
  assert.equal(bodies[0].keep_alive, KEEP_ALIVE);
  assert.ok(bodies[0].options.num_predict <= 128);
});

test('memory records visits, searches, takes, water, beds and a safehouse score', () => {
  const { percept } = loadFixture('v2-night-tired-bed.json');
  const mem = emptyMemory();
  updateMemory(mem, percept, NOW);
  const b = mem.buildings['4033'];
  assert.equal(b.visited, true);
  assert.equal(b.water, true);
  assert.equal(b.bed, true);
  assert.equal(b.res, true);
  assert.ok(mem.buildings['4031'], 'the other building in sight is known');
  recordOrder(mem, 60, { verb: 'SEARCH', key: 'SEARCH:4033' }, percept);
  updateMemory(mem, { ...percept, res: { seq: 60, verb: 'SEARCH', status: 'done', why: 'took 2: Crowbar, Beans (full)' } }, NOW);
  assert.equal(b.searched, false, 'stopped on weight, rooms left');
  assert.equal(b.partly, true);
  assert.deepEqual(b.took, ['Crowbar', 'Beans']);
  recordOrder(mem, 61, { verb: 'SEARCH', key: 'SEARCH:4033' }, percept);
  updateMemory(mem, { ...percept, res: { seq: 61, verb: 'SEARCH', status: 'failed', why: 'nothing left' } }, NOW);
  assert.equal(b.searched, true);
  assert.ok(safehouseScore(b) >= 5);
  assert.deepEqual(tookItems('took nothing'), []);
  // Saved and loaded through pz-state.json.
  const back = loadMemory(JSON.parse(JSON.stringify(mem)));
  assert.equal(back.buildings['4033'].searched, true);
  assert.deepEqual(loadMemory('junk'), emptyMemory());
});

test('asleep: no orders until he wakes', () => {
  const { percept, memory } = loadFixture('v2-asleep.json');
  assert.ok(memory.sleep);
  assert.equal(planTurn(percept, memory, { now: NOW }).kind, 'asleep');
  updateMemory(memory, { ...percept, fatigue: 0.05 }, NOW + 1000);
  assert.equal(memory.sleep, null);
  assert.notEqual(planTurn({ ...percept, fatigue: 0.05 }, memory, { now: NOW + 1000 }).kind, 'asleep');
});

test('playbook: only rules that hold, at most 5', () => {
  const night = loadFixture('v2-night-outside.json');
  const rules = selectRules(night.percept, night.memory).map((r) => r.id);
  assert.ok(rules.includes('night'));
  assert.ok(rules.includes('quiet-entry'));
  assert.equal(rules.includes('wounded'), false);
  const idle = loadFixture('v2-outside-unaware-near.json');
  assert.ok(selectRules(idle.percept, idle.memory).some((r) => r.id === 'one-at-a-time'));
  const searched = loadFixture('v2-day-searched-house.json');
  assert.ok(selectRules(searched.percept, searched.memory).some((r) => r.id === 'new-houses'));
  const worst = { ...night.percept, wounds: [{ part: 'Hand_L', bleed: true }], weapon: 'none', weapons: [], inv: { waterL: 0 }, weight: 9, maxWeight: 8, fatigue: 0.9 };
  assert.equal(selectRules(worst, night.memory).length, MAX_RULES);
});

test('planTurn: hold, policy, ask, and quiet while a skill runs', () => {
  const plan = (name, ctx = {}) => {
    const { percept, memory } = loadFixture(name);
    return planTurn(percept, memory, { now: NOW, ...ctx });
  };
  assert.equal(plan('v2-outside-chased.json').kind, 'hold');
  assert.equal(plan('v2-bleeding.json').kind, 'policy');
  const ask = plan('v2-outside-unaware-near.json');
  assert.equal(ask.kind, 'ask');
  assert.match(ask.user, /OPTIONS:\nb1: walk into house/);
  assert.match(ask.user, /Pick one id: b1, away/);

  const { percept, memory } = loadFixture('v2-searching.json');
  const last = snapshot(percept, NOW);
  assert.equal(planTurn(percept, memory, { now: NOW + 5000, last }).kind, 'skill');
  // At the 20 second check with nothing worth stopping for, the model is not asked either.
  const later = planTurn(percept, memory, { now: NOW + RECHECK_MS, last });
  assert.equal(later.kind, 'skill');
  assert.equal(later.touch, true);
  const thirsty = { ...percept, thirst: 0.5, moodle: { ...percept.moodle, thirsty: 1 } };
  const asked = planTurn(thirsty, memory, { now: NOW + RECHECK_MS, last });
  assert.equal(asked.kind, 'ask');
  assert.deepEqual(ids(asked.options), ['drink', 'keep']);
  const bleeding = { ...percept, bleeding: 1, wounds: [{ part: 'Hand_L', bleed: true }], inv: { ...percept.inv, bandages: 1 } };
  assert.ok(!needs(percept).has('bleeding') && needs(bleeding).has('bleeding'));
  const urgent = planTurn(bleeding, memory, { now: NOW + 5000, last });
  assert.equal(urgent.kind, 'policy');
  assert.equal(urgent.policy.option.verb, 'BANDAGE');
  const chase = { ...percept, zChasing: 1, zList: [{ dx: 20, dy: 0, d: 20, chase: true }] };
  assert.equal(planTurn(chase, memory, { now: NOW + 5000, last }).kind, 'ask');
  assert.equal(planTurn(percept, memory, { now: NOW + 5000, last, voice: ['hi'] }).kind, 'ask');
});

test('planTurn waits for the body to pick up the last order', () => {
  const { percept, memory } = loadFixture('v2-outside-unaware-near.json');
  assert.equal(planTurn(percept, memory, { now: NOW, pending: { seq: 41, at: NOW - 2000 } }).kind, 'pending');
  assert.equal(planTurn({ ...percept, lastSeq: 41 }, memory, { now: NOW, pending: { seq: 41, at: NOW - 2000 } }).kind, 'ask');
  assert.equal(planTurn(percept, memory, { now: NOW, pending: { seq: 41, at: NOW - 11_000 } }).kind, 'ask');
});

test('a voice gets an answer even when the policy decides', () => {
  const { percept, memory } = loadFixture('v2-bleeding.json');
  const p = planTurn(percept, memory, { now: NOW, voice: ['Are you ok?'] });
  assert.equal(p.kind, 'ask');
  assert.deepEqual(ids(p.options), ['bandage']);
  assert.match(p.user, /"Are you ok\?" Answer it in the thought/);
});

test('resolveChoice and the order line', () => {
  const { percept, memory } = loadFixture('v2-searching.json');
  const thirsty = { ...percept, thirst: 0.5 };
  const opts = buildOptions(thirsty, memory, { now: NOW });
  assert.equal(resolveChoice(thirsty, memory, opts, 'keep'), null);
  assert.equal(resolveChoice(thirsty, memory, opts, 'drink').verb, 'DRINK');
  // The same job again would restart it, so it counts as keep.
  recordOrder(memory, 20, { verb: 'SEARCH', key: 'SEARCH:4021' }, percept);
  assert.equal(resolveChoice(percept, memory, [{ id: 'search', verb: 'SEARCH', key: 'SEARCH:4021' }], 'search'), null);
  const idle = loadFixture('v2-day-searched-house.json');
  const enter = byId(buildOptions(idle.percept, idle.memory, { now: NOW }), 'b1');
  assert.equal(orderLine(7, enter, 'New house.', ''), `7|ENTER|0|0||New house.|${enter.label.slice(0, 90)}|4022`);
  const away = loadFixture('v2-outside-unaware-near.json');
  const go = byId(buildOptions(away.percept, away.memory, { now: NOW }), 'away');
  assert.match(orderLine(8, go, 'Around it.'), new RegExp(`^8\\|GOTO\\|${go.a}\\|${go.b}\\|\\|Around it\\.\\|`));
});
