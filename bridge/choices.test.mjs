// What the brain does with the newer percept fields: asleep, res.target, inBldg.roomsLeft,
// inv.canRip, weapon scores, and the DROP verb. Each test builds its moment from the eval base.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario } from './eval/scenarios.mjs';
import { buildOptions, runningKey } from './options.mjs';
import { decidePolicy, POLICY_RULES } from './policy.mjs';
import { planTurn, resolveChoice } from './brain.mjs';
import { selectRules } from './playbook.mjs';
import { updateMemory, recordOrder, blockedWhy, building } from './memory.mjs';
import { running, LONG_VERBS, isAsleep, canTreat, betterWeapon, weaponPoor } from './senses.mjs';

const NOW = 1_000_000;
const ids = (opts) => opts.map((o) => o.id);
const byId = (opts, id) => opts.find((o) => o.id === id);

// A moment from the eval base: patch over the percept, seed memory, an optional day plan.
function moment(patch = {}, memory = {}, plan = null) {
  return buildScenario({ patch, memory, plan });
}
const menu = (m) => buildOptions(m.percept, m.memory, { now: NOW, plan: m.plan });
const policy = (m) => decidePolicy(m.percept, m.memory, menu(m));

const INSIDE = {
  outside: false, room: 'kitchen', bldgDir: 'HERE', bldgDist: 0,
  inBldg: { explored: false, id: '4021', room: 'kitchen', rooms: 6, roomsLeft: 6, water: false },
  buildings: [{ d: 0, door: { x: 10650, y: 9826 }, dx: 0, dy: 0, id: '4021', res: true, shop: false, visited: true }],
};
const INSIDE_MEM = { current: '4021', buildings: { 4021: { visited: true, res: true, enteredAt: 38, securedAt: 39 } } };
const HOME_MEM = { buildings: { 4021: { visited: true, searched: true, res: true, water: true, bed: true, door: { x: 10600, y: 9800 } } } };
const PLAN = { goal: 'Be home before dark', steps: ['go home'], home: '4021' };

test('asleep: the percept flag beats the guess, and the guess stands in when it is missing', () => {
  const m = moment({ asleep: true });
  assert.equal(m.memory.sleep, null, 'no SLEEP result was seen, so no guess');
  assert.equal(isAsleep(m.percept, m.memory), true);
  assert.equal(planTurn(m.percept, m.memory, { now: NOW }).kind, 'asleep');
  // The flag says awake while a stale guess says asleep: awake wins and the guess is dropped.
  const guess = { at: NOW, hours: 40, x: 10650, y: 9830 };
  const awake = moment({ asleep: false, fatigue: 0.9, res: { seq: 53, status: 'done', verb: 'SLEEP', why: 'asleep in bed' } });
  awake.memory.sleep = guess;
  assert.equal(isAsleep(awake.percept, awake.memory), false);
  assert.notEqual(planTurn(awake.percept, awake.memory, { now: NOW }).kind, 'asleep');
  updateMemory(awake.memory, awake.percept, NOW);
  assert.equal(awake.memory.sleep, null);
  // No flag: the guess decides, as before.
  const old = moment({});
  old.memory.sleep = guess;
  assert.equal(isAsleep(old.percept, old.memory), true);
  // A flag of the wrong type is not a flag.
  const odd = moment({ asleep: 'yes' });
  assert.equal(isAsleep(odd.percept, odd.memory), false);
});

test('res.target names the running job when the bridge has no record of the order', () => {
  const walking = moment({ res: { seq: 70, verb: 'ENTER', status: 'running', why: '', target: '4060' } });
  assert.equal(running(walking.percept).verb, 'ENTER');
  assert.equal(runningKey(walking.percept, walking.memory), 'ENTER:4060');
  // The house being entered is not offered again, and a second house still is: a walk may change its mind.
  const two = moment({
    res: { seq: 70, verb: 'ENTER', status: 'running', why: '', target: '4060' },
    buildings: [
      { d: 9, door: { x: 10651, y: 9821 }, dx: 0, dy: -9, id: '4060', res: true, shop: false, visited: false },
      { d: 14, door: { x: 10664, y: 9830 }, dx: 14, dy: 0, id: '4061', res: true, shop: false, visited: false },
    ],
  });
  const targets = menu(two).filter((o) => o.verb === 'ENTER').map((o) => o.target);
  assert.deepEqual(targets, ['4061']);
  // Choosing the entry the body is already walking to is "keep", not a restart.
  const again = buildOptions({ ...two.percept, buildings: [two.percept.buildings[0]] }, two.memory, { now: NOW });
  assert.equal(byId(again, 'b1'), undefined);

  const searching = moment({ ...INSIDE, res: { seq: 20, verb: 'SEARCH', status: 'running', why: '', target: '4021' } }, INSIDE_MEM);
  assert.equal(runningKey(searching.percept, searching.memory), 'SEARCH:4021');
  assert.deepEqual(ids(menu(searching)), ['keep']);

  // A GOTO is matched by its end tile against this turn's walks.
  const home = moment({ hour: 18, fatigue: 0.65, buildings: [], res: { seq: 71, verb: 'GOTO', status: 'running', why: '', target: '10600,9800' } }, HOME_MEM, PLAN);
  const opts = buildOptions(home.percept, home.memory, { now: NOW, plan: PLAN });
  assert.equal(runningKey(home.percept, home.memory, [{ verb: 'GOTO', a: 10600, b: 9800, key: 'HOME:4021' }]), 'HOME:4021');
  assert.equal(byId(opts, 'home'), undefined, 'the walk home is the running job');
  assert.ok(byId(opts, 'keep'));
  // A target that is not a string, or matches nothing, falls back to the verb.
  assert.equal(runningKey({ res: { seq: 9, verb: 'GOTO', status: 'running', target: 5 } }, { orders: [] }, []), null);
  assert.equal(runningKey({ res: { seq: 9, verb: 'GOTO', status: 'running', target: '1,2' } }, { orders: [] }, []), null);
  // The bridge's own record still comes first.
  const mem = { orders: [{ seq: 9, key: 'AWAY' }] };
  assert.equal(runningKey({ res: { seq: 9, verb: 'GOTO', status: 'running', target: '1,2' } }, mem, []), 'AWAY');
  // resolveChoice treats the walk's own option as keep when the target says so.
  const same = [{ id: 'home', verb: 'GOTO', a: 10600, b: 9800, key: 'HOME:4021' }];
  assert.equal(resolveChoice(home.percept, home.memory, same, 'home'), null);
});

test('SEARCH says how many rooms are left, and is not offered at 0', () => {
  const some = moment({ ...INSIDE, inBldg: { ...INSIDE.inBldg, roomsLeft: 2 } }, INSIDE_MEM);
  const search = byId(menu(some), 'search');
  assert.match(search.label, /2 rooms left/);
  assert.match(search.label, /partly searched/, '2 of 6 rooms are done');
  const all = moment({ ...INSIDE, inBldg: { ...INSIDE.inBldg, roomsLeft: 6 } }, INSIDE_MEM);
  assert.match(byId(menu(all), 'search').label, /6 rooms left, not searched yet/);
  const one = moment({ ...INSIDE, inBldg: { ...INSIDE.inBldg, roomsLeft: 1 } }, INSIDE_MEM);
  assert.match(byId(menu(one), 'search').label, /1 room left/);
  const done = moment({ ...INSIDE, inBldg: { ...INSIDE.inBldg, roomsLeft: 0 } }, INSIDE_MEM);
  assert.equal(byId(menu(done), 'search'), undefined);
  assert.equal(building(done.memory, '4021').searched, true, 'memory takes the body at its word');
  // An older mod sends no roomsLeft: the old label, and the map memory decides.
  const { roomsLeft, ...old } = INSIDE.inBldg;
  const none = moment({ ...INSIDE, inBldg: old }, INSIDE_MEM);
  assert.match(byId(menu(none), 'search').label, /\(6 rooms, not searched yet\)/);
  // Junk in the field is not a count.
  for (const bad of ['0', null, 'many', NaN]) {
    const m = moment({ ...INSIDE, inBldg: { ...INSIDE.inBldg, roomsLeft: bad } }, INSIDE_MEM);
    assert.ok(byId(menu(m), 'search'), `roomsLeft ${String(bad)} is ignored`);
  }
});

test('BANDAGE only when a bandage is carried or one could be ripped', () => {
  const wound = { bleeding: 1, hp: 62, wounds: [{ part: 'Leg_L', bleed: true, deep: true }] };
  const none = moment({ ...wound, inv: { bandages: 0, canRip: false } });
  assert.equal(byId(menu(none), 'bandage'), undefined);
  assert.equal(canTreat(none.percept), false);
  assert.equal(policy(none), null, 'the bleeding rule steps aside when there is nothing to bandage with');
  const rip = moment({ ...wound, inv: { bandages: 0, canRip: true } });
  assert.match(byId(menu(rip), 'bandage').label, /rip cloth/);
  assert.equal(policy(rip).rule, 'bleeding');
  const carried = moment({ ...wound, inv: { bandages: 2, canRip: false } });
  assert.doesNotMatch(byId(menu(carried), 'bandage').label, /rip/);
  // Older mod: no canRip, so anyone bleeding may try.
  const old = moment({ ...wound, inv: { bandages: 0 } });
  assert.ok(byId(menu(old), 'bandage'));
  // Not bleeding, a scratch, no kit: nothing to try.
  const scratch = moment({ wounds: [{ part: 'Hand_L', scratch: true }], inv: { bandages: 0 } });
  assert.equal(byId(menu(scratch), 'bandage'), undefined);
  // The playbook does not tell her to treat what she cannot.
  assert.ok(!selectRules(none.percept, none.memory).some((r) => r.id === 'wounded'));
  assert.ok(selectRules(rip.percept, rip.memory).some((r) => r.id === 'wounded'));
});

test('policy: eat when hungry and food is ready', () => {
  const m = moment({ hunger: 0.7, moodle: { hungry: 2 } });
  const got = policy(m);
  assert.equal(got.rule, 'hunger');
  assert.equal(got.option.verb, 'EAT');
  // Merely peckish is the model's call. So is a can that needs opening.
  assert.equal(policy(moment({ hunger: 0.4, moodle: { hungry: 1 } })), null);
  assert.equal(policy(moment({ hunger: 0.7, moodle: { hungry: 2 }, inv: { foodReady: 0, cans: 2, canOpener: true } })), null);
  // Not twice: while EAT runs the option is "keep".
  const eating = moment({ hunger: 0.7, moodle: { hungry: 2 }, res: { seq: 5, verb: 'EAT', status: 'running', why: '', target: 'Beans' } });
  assert.equal(policy(eating), null);
  // A failed EAT is off the menu for a while.
  recordOrder(m.memory, 6, { verb: 'EAT', key: 'EAT' }, m.percept, NOW);
  updateMemory(m.memory, { ...m.percept, res: { seq: 6, verb: 'EAT', status: 'failed', why: 'too full' } }, NOW);
  assert.equal(policy(m), null);
});

test('policy: bleeding stays first, then thirst, then hunger', () => {
  const ruleIds = POLICY_RULES.map((r) => r.id);
  assert.deepEqual(ruleIds, ['bleeding', 'thirst', 'hunger', 'equip', 'night-outside', 'night-secure', 'sleep', 'overloaded']);
  const all = moment({
    ...INSIDE, bleeding: 1, wounds: [{ part: 'Hand_L', bleed: true }], thirst: 0.8, moodle: { thirsty: 3, hungry: 3, heavy: 2 }, hunger: 0.8, weight: 8,
  }, INSIDE_MEM);
  assert.equal(policy(all).rule, 'bleeding');
  const thirstFirst = moment({ ...INSIDE, thirst: 0.8, moodle: { thirsty: 3, hungry: 3 }, hunger: 0.8 }, INSIDE_MEM);
  assert.equal(policy(thirstFirst).rule, 'thirst');
});

test('policy: equip a carried weapon that scores clearly better, or any real one when unarmed', () => {
  const axe = { n: 'Axe', cond: 0.9, dmg: 2.2, reach: 1.2, score: 51 };
  const knife = { n: 'Kitchen Knife', cond: 1, dmg: 0.6, reach: 0.9, score: 9 };
  const swap = moment({ weapon: 'Kitchen Knife', weaponScore: 9, weapons: [axe, knife] });
  const got = policy(swap);
  assert.equal(got.rule, 'equip');
  assert.equal(got.option.verb, 'EQUIP');
  assert.match(got.option.label, /Axe/);
  assert.equal(betterWeapon(swap.percept).swap, true);
  // 25% over is the line: 30 over 24 is exactly 1.25, 29 over 24 is not enough.
  const edge = (score) => moment({ weapon: 'Crowbar', weaponScore: 24, weapons: [{ ...axe, n: 'Bat', score }, { ...knife, n: 'Crowbar', score: 24 }] });
  assert.ok(byId(menu(edge(30)), 'equip'));
  assert.equal(byId(menu(edge(29)), 'equip'), undefined);
  assert.equal(policy(edge(29)), null);
  // The weapon in hand is on the list too and must not count as better than itself.
  assert.equal(betterWeapon(moment({ weapon: 'Axe', weaponScore: 51, weapons: [axe, knife] }).percept), null);
  // Empty hands: anything in the bag, scored or not (an older mod sends no score).
  assert.equal(policy(moment({ weapon: 'none', weaponScore: 0, weapons: [knife] })).rule, 'equip');
  const unscored = moment({ weapon: 'none', weapons: [{ n: 'Bat', cond: 1, dmg: 1.3, reach: 1.2 }] });
  assert.match(byId(menu(unscored), 'equip').label, /hold the Bat/);
  // An armed percept with no scores at all gets no swap.
  assert.equal(betterWeapon(moment({ weapon: 'Bat', weapons: [{ n: 'Axe' }, { n: 'Bat' }] }).percept), null);
  // Scores of the wrong type are not scores.
  assert.equal(betterWeapon(moment({ weapon: 'Bat', weaponScore: '9', weapons: [{ n: 'Axe', score: '51' }] }).percept), null);
  // Nothing carried: nothing to equip.
  assert.equal(betterWeapon(moment({ weapon: 'none', weapons: [] }).percept), null);
});

test('EQUIP is not sent again while the weapon is being raised', () => {
  const m = moment({ weapon: 'none', weaponScore: 0, weapons: [{ n: 'Axe', cond: 1, dmg: 2, reach: 1.2, score: 51 }] });
  const first = policy(m);
  assert.equal(first.option.verb, 'EQUIP');
  recordOrder(m.memory, 8, first.option, m.percept, NOW);
  assert.equal(blockedWhy(m.memory, 'EQUIP', NOW + 1000), 'just sent');
  assert.equal(policy(m), null, 'the same percept a moment later');
  // It comes back if the weapon still is not in hand a while later.
  const later = decidePolicy(m.percept, m.memory, buildOptions(m.percept, m.memory, { now: NOW + 60_000 }));
  assert.equal(later.rule, 'equip');
  // A done result lifts the block at once.
  recordOrder(m.memory, 9, first.option, m.percept, NOW);
  updateMemory(m.memory, { ...m.percept, res: { seq: 9, verb: 'EQUIP', status: 'done', why: 'already holding the best' } }, NOW);
  assert.equal(blockedWhy(m.memory, 'EQUIP', NOW + 1000), '');
});

test('policy: drop the junk when overloaded', () => {
  const heavy = moment({ weight: 7.5, moodle: { heavy: 2 } });
  const got = policy(heavy);
  assert.equal(got.rule, 'overloaded');
  assert.equal(got.option.verb, 'DROP');
  assert.match(got.option.label, /7\.5 of 8/);
  // The load line is 85% of the maximum even without the moodle.
  assert.equal(policy(moment({ weight: 6.9 })).option.verb, 'DROP');
  assert.equal(policy(moment({ weight: 6 })), null);
  // Not with a zombie after her, nor one this close. The reflex has the fight.
  const chased = moment({ weight: 7.5, zChasing: 1, zList: [{ dx: 30, dy: 0, d: 30, chase: true }] });
  assert.equal(byId(menu(chased), 'drop'), undefined);
  assert.equal(byId(menu(moment({ weight: 7.5, zList: [{ dx: 6, dy: 0, d: 6 }] })), 'drop'), undefined);
  // While it runs the menu is just keep, and a failed one stays off for a while.
  const running_ = moment({ weight: 7.5, res: { seq: 4, verb: 'DROP', status: 'running', why: '', target: '' } });
  assert.deepEqual(ids(menu(running_)), ['keep']);
  assert.ok(LONG_VERBS.has('DROP'));
  // Choosing it sends DROP, which takes no arguments.
  const sent = resolveChoice(heavy.percept, heavy.memory, menu(heavy), 'drop');
  assert.deepEqual([sent.verb, sent.a, sent.b, sent.target], ['DROP', 0, 0, '']);
  recordOrder(heavy.memory, 7, got.option, heavy.percept, NOW);
  updateMemory(heavy.memory, { ...heavy.percept, res: { seq: 7, verb: 'DROP', status: 'failed', why: 'not heavy' } }, NOW);
  assert.equal(blockedWhy(heavy.memory, 'DROP', NOW + 60_000), 'not heavy');
  assert.equal(byId(buildOptions(heavy.percept, heavy.memory, { now: NOW + 60_000 }), 'drop'), undefined);
  assert.ok(byId(buildOptions(heavy.percept, heavy.memory, { now: NOW + 4 * 60_000 }), 'drop'));
});

test('unarmed or weak: houses not yet searched come first and the label says why', () => {
  const buildings = [
    { d: 7, door: { x: 10657, y: 9830 }, dx: 7, dy: 0, id: '4062', res: false, shop: true, visited: false },
    { d: 15, door: { x: 10650, y: 9815 }, dx: 0, dy: -15, id: '4060', res: true, shop: false, visited: false },
  ];
  const bare = moment({ weapon: 'none', weaponScore: 0, weapons: [], buildings });
  assert.equal(weaponPoor(bare.percept), true);
  const opts = menu(bare);
  assert.equal(byId(opts, 'b1').target, '4060', 'the farther house, over the nearer shop');
  assert.match(byId(opts, 'b1').label, /no real weapon yet/);
  assert.doesNotMatch(byId(opts, 'b2').label, /weapon/, 'a shop is not sold as the place to look');
  // Armed with a real weapon: the old order (nearest first) and no tag.
  const armed = moment({ weapon: 'Baseball Bat', weaponScore: 34, weapons: [{ n: 'Baseball Bat', cond: 0.7, dmg: 1.3, reach: 1.25, score: 34 }], buildings });
  assert.equal(weaponPoor(armed.percept), false);
  assert.equal(byId(menu(armed), 'b1').target, '4062');
  assert.doesNotMatch(byId(menu(armed), 'b1').label, /weapon/);
  // A kitchen knife is weak, a hammer too, a crowbar is not.
  const weak = (score) => moment({ weapon: 'Thing', weaponScore: score, weapons: [{ n: 'Thing', cond: 1, dmg: 1, reach: 1, score }], buildings });
  assert.equal(weaponPoor(weak(9).percept), true);
  assert.equal(weaponPoor(weak(19).percept), true);
  assert.equal(weaponPoor(weak(30).percept), false);
  assert.match(byId(menu(weak(9)), 'b1').label, /no real weapon yet/);
  // Carrying a real weapon in the bag is not poor: she is about to hold it.
  assert.equal(weaponPoor(moment({ weapon: 'none', weaponScore: 0, weapons: [{ n: 'Axe', score: 51 }] }).percept), false);
  // An older mod with no scores: only empty hands and an empty bag count.
  assert.equal(weaponPoor(moment({ weapon: 'Baseball Bat', weapons: [{ n: 'Baseball Bat' }] }).percept), false);
  // A searched house is not sold as a weapon hunt.
  const searched = moment({ weapon: 'none', weaponScore: 0, weapons: [], buildings: [buildings[1]] }, { buildings: { 4060: { visited: true, searched: true, res: true } } });
  assert.doesNotMatch(byId(menu(searched), 'b1').label, /weapon/);
  // The playbook says so for a weak weapon, and the empty-hands rule is unchanged.
  assert.ok(selectRules(weak(9).percept, weak(9).memory).some((r) => r.id === 'weak-weapon'));
  assert.ok(!selectRules(weak(30).percept, weak(30).memory).some((r) => r.id === 'weak-weapon'));
  const rules = selectRules(bare.percept, bare.memory).map((r) => r.id);
  assert.ok(rules.includes('no-weapon') && !rules.includes('weak-weapon'));
});

test('walk home: a GOTO to the remembered door when the home is out of the nearby list', () => {
  const m = moment({ hour: 18, fatigue: 0.65, moodle: { tired: 2 }, buildings: [] }, HOME_MEM, PLAN);
  const opts = menu(m);
  const home = byId(opts, 'home');
  assert.equal(home.verb, 'GOTO');
  assert.deepEqual([home.a, home.b], [10600, 9800]);
  assert.equal(home.key, 'HOME:4021');
  assert.match(home.label, /your planned home/);
  assert.match(home.label, /safe house/);
  assert.match(home.label, /NW/);
  assert.ok(home.label.length < 120);
  assert.equal(opts.findIndex((o) => o.id === 'home'), 0, 'leads the menu at dusk');
  // By day, rested, it is still there but a house in sight comes first.
  const noon = menu(moment({}, HOME_MEM, PLAN));
  assert.ok(byId(noon, 'home'));
  assert.equal(noon[0].id, 'b1');
  // No plan, or a plan with another home: nothing.
  assert.equal(byId(buildOptions(m.percept, m.memory, { now: NOW }), 'home'), undefined);
  assert.equal(byId(buildOptions(m.percept, m.memory, { now: NOW, plan: { ...PLAN, home: '9999' } }), 'home'), undefined);
  // In the nearby list: ENTER handles it.
  const near = moment({ hour: 18, buildings: [{ d: 20, door: { x: 10600, y: 9800 }, dx: -20, dy: 0, id: '4021', res: true, shop: false, visited: true }] }, HOME_MEM, PLAN);
  assert.equal(byId(menu(near), 'home'), undefined);
  assert.equal(byId(menu(near), 'b1').target, '4021');
  // Standing in it: nothing to walk to.
  const there = moment({ ...INSIDE, hour: 18 }, { ...INSIDE_MEM, buildings: { 4021: { ...INSIDE_MEM.buildings[4021], door: { x: 10600, y: 9800 } } } }, PLAN);
  assert.equal(byId(menu(there), 'home'), undefined);
  // No door on record: no walk. Too far: no walk.
  const noDoor = moment({ hour: 18, buildings: [] }, { buildings: { 4021: { visited: true, res: true } } }, PLAN);
  assert.equal(byId(menu(noDoor), 'home'), undefined);
  const far = moment({ hour: 18, buildings: [] }, { buildings: { 4021: { visited: true, res: true, door: { x: 10650 + 500, y: 9830 } } } }, PLAN);
  assert.equal(byId(menu(far), 'home'), undefined);
  // A walk that fails stays off for a while.
  recordOrder(m.memory, 12, home, m.percept, NOW);
  updateMemory(m.memory, { ...m.percept, res: { seq: 12, verb: 'GOTO', status: 'failed', why: 'unreachable' } }, NOW);
  assert.equal(byId(buildOptions(m.percept, m.memory, { now: NOW + 1000, plan: PLAN }), 'home'), undefined);
  assert.ok(byId(buildOptions(m.percept, m.memory, { now: NOW + 100_000, plan: PLAN }), 'home'));
  // The path must keep clear of an idle zombie, like every other walk.
  const blocked = moment({ hour: 18, buildings: [], zList: [{ dx: -12, dy: -7, d: 14, chase: false }] }, HOME_MEM, PLAN);
  assert.equal(byId(menu(blocked), 'home'), undefined);
});

test('walk home at night: not when a closer shelter is offered', () => {
  const closer = moment({ hour: 22, dark: true }, HOME_MEM, PLAN);
  assert.ok(byId(menu(closer), 'b1'), 'the base house, 9 tiles north');
  assert.equal(byId(menu(closer), 'home'), undefined);
  assert.equal(policy(closer).rule, 'night-outside');
  // The only shelter on the menu is farther than home: walk home.
  const farther = moment({
    hour: 22, dark: true,
    buildings: [{ d: 70, door: { x: 10650, y: 9760 }, dx: 0, dy: -70, id: '4060', res: true, shop: false, visited: false }],
  }, HOME_MEM, PLAN);
  assert.ok(byId(menu(farther), 'home'));
  // Nothing in sight at all: the walk is the shelter, and the policy leaves it to the model.
  const none = moment({ hour: 22, dark: true, buildings: [] }, HOME_MEM, PLAN);
  assert.ok(byId(menu(none), 'home'));
  assert.equal(policy(none), null);
  // By day a closer house does not hide it.
  const day = moment({ hour: 18, fatigue: 0.65 }, HOME_MEM, PLAN);
  assert.ok(byId(menu(day), 'home'));
});

test('memory keeps a building\'s door after it leaves the nearby list, and ignores a bad one', () => {
  const m = moment({ buildings: [{ d: 9, door: { x: 10651, y: 9821 }, dx: 0, dy: -9, id: '4060', res: true, shop: false, visited: false }] });
  assert.deepEqual(building(m.memory, '4060').door, { x: 10651, y: 9821 });
  updateMemory(m.memory, { ...m.percept, buildings: [] }, NOW);
  assert.deepEqual(building(m.memory, '4060').door, { x: 10651, y: 9821 });
  updateMemory(m.memory, { ...m.percept, buildings: [{ ...m.percept.buildings[0], door: null }] }, NOW);
  assert.deepEqual(building(m.memory, '4060').door, { x: 10651, y: 9821 }, 'a null door does not erase it');
  for (const bad of ['north', 5, { x: 'a', y: 2 }, { y: 2 }, []]) {
    const b = moment({ buildings: [{ d: 9, door: bad, dx: 0, dy: -9, id: '4070', res: true, shop: false, visited: false }] });
    assert.equal(building(b.memory, '4070').door, undefined, `door ${JSON.stringify(bad)} is ignored`);
  }
});

test('the menu with the new options stays legal, short and ends in wait', () => {
  const busy = moment({
    ...INSIDE, hunger: 0.7, moodle: { hungry: 2, heavy: 2 }, weight: 7.5, thirst: 0.5, bleeding: 1, wounds: [{ part: 'Hand_L', bleed: true }],
    weapon: 'Kitchen Knife', weaponScore: 9, weapons: [{ n: 'Axe', score: 51 }, { n: 'Kitchen Knife', score: 9 }], hour: 18, fatigue: 0.7,
  }, { ...INSIDE_MEM, buildings: { 4021: { ...INSIDE_MEM.buildings[4021], door: { x: 10650, y: 9826 } }, 4055: { visited: true, res: true, door: { x: 10590, y: 9800 } } } }, { ...PLAN, home: '4055' });
  const opts = menu(busy);
  assert.ok(opts.length <= 8);
  assert.equal(new Set(ids(opts)).size, opts.length);
  assert.equal(opts[opts.length - 1].id, 'wait');
  for (const o of opts) assert.ok(o.label && o.label.length < 120, `${o.id}: ${o.label}`);
  for (const o of opts) assert.equal('d' in o, false, 'no scratch fields leak into the menu');
  assert.equal(planTurn(busy.percept, busy.memory, { now: NOW, plan: busy.plan }).policy.rule, 'bleeding');
});
