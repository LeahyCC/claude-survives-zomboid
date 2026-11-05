import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractJSON, normalize, steerJob, intentLine, zombieInside, buildPrompt, V1_FIELDS } from './decide.mjs';

const plain = extractJSON('{"action":{"type":"LOOT"},"thought":"Grab it."}');
assert.equal(normalize(plain).type, 'LOOT');

const thought = extractJSON('<think>walk east?</think>\n{"action":{"type":"MOVE","dx":20,"dy":-5},"say":"east"}');
const moved = normalize(thought);
assert.equal(moved.type, 'MOVE');
assert.equal(moved.dx, 20);
assert.equal(moved.dy, -5);

const junk = normalize(extractJSON('sure\n{"action":{"type":"sprint","dx":99,"dy":-99},"say":"a|b"}'));
assert.equal(junk.type, 'WAIT');
assert.equal(junk.dx, 40);
assert.equal(junk.dy, -40);
assert.equal(junk.say, 'a b');

const line = intentLine(3, normalize({ action: { type: 'WAIT' }, thought: 'holding', subtask: 'hide' }));
assert.equal(line, '3|WAIT|0|0||holding|hide|');

const aimed = intentLine(4, { ...normalize({ action: { type: 'LOOT' }, thought: 'grab' }), target: ' door|7\nnorth ' });
assert.equal(aimed, '4|LOOT|0|0||grab||door 7 north');

// Skills the body knows but this prompt does not offer stay WAIT, so a model cannot pick them by accident.
for (const type of ['GOTO', 'ENTER', 'SEARCH']) assert.equal(normalize({ action: { type, dx: 16, dy: 0 } }).type, 'WAIT');
assert.equal(normalize({ action: { type: 'LOOT', target: 'B|1' } }).target, 'B 1');
assert.equal(intentLine(5, normalize({ action: { type: 'LOOT' }, target: '123' })), '5|LOOT|0|0||||123');

const inch = normalize({ action: { type: 'MOVE', dx: -1, dy: 0 } });
assert.equal(inch.type, 'MOVE');
assert.equal(inch.dx, -16);
assert.equal(inch.dy, 0);

const stuck = normalize({ action: { type: 'MOVE', dx: 0, dy: 0 } });
assert.equal(stuck.type, 'WAIT');

const wander = steerJob(
  { type: 'MOVE', dx: -20, dy: 0, thought: 'Get to safety.' },
  { zClose: 0, weapon: 'none', foods: 0, bldgDir: 'E', bldgDist: 5 },
);
assert.equal(wander.type, 'LOOT');

const far = steerJob(
  { type: 'MOVE', dx: -20, dy: 0 },
  { zClose: 0, weapon: 'none', foods: 0, bldgDir: 'E', bldgDist: 20 },
);
assert.equal(far.type, 'MOVE');
assert.equal(far.dx, 16);
assert.equal(far.dy, 0);

const armed = steerJob(
  { type: 'LOOT' },
  { zClose: 0, weapon: 'none', foods: 0, bldgDir: 'HERE', bldgDist: 2, items: 'Belt, Scalpel' },
);
assert.equal(armed.type, 'EQUIP');

const busy = steerJob(
  { type: 'LOOT' },
  { zClose: 0, weapon: 'none', qlen: 2, bldgDir: 'HERE', bldgDist: 2, items: 'Scalpel' },
);
assert.equal(busy.type, 'WAIT');

const planted = steerJob(
  { type: 'STOP', thought: 'Safely inside.' },
  { zClose: 0, weapon: 'Scalpel', foods: 0, bldgDir: 'HERE', bldgDist: 3, zDir: 'SE', qlen: 0 },
);
// The walk-away from a cleared room is gone: it walked into walls and looped the unstick helper.
assert.equal(planted.type, 'STOP');

const bitten = steerJob(
  { type: 'MOVE', dx: -20, dy: 0 },
  { zClose: 2, weapon: 'none', foods: 0, bldgDir: 'E', bldgDist: 5 },
);
assert.equal(bitten.dx, -20);

assert.equal(zombieInside({ zClose: 1, zDist: 6 }), true);
assert.equal(zombieInside({ zClose: 0, zDist: 14 }), false);
assert.equal(zombieInside({ dead: true, zClose: 3 }), false);
assert.equal(zombieInside(null), false);

const asked = buildPrompt({ goal: 'Get a weapon.', subtask: 'Loot.', memory: 'long scratch', log: [] }, { zClose: 0 }, ['hello']);
assert.match(asked, /\{"action":\{"type":"MOVE"/);
assert.equal(asked.includes('"subtask"'), false);
assert.equal(asked.includes('"memory"'), false);
assert.equal(asked.includes('"reply"'), false);
assert.match(asked, /Answer it in the thought/);

const clothes = { zClose: 0, weapon: 'none', foods: 0, bldgDir: 'HERE', bldgDist: 2, qlen: 0, items: 'Belt, Shirt' };
assert.equal(steerJob({ type: 'LOOT' }, { ...clothes, err: '' }).type, 'EQUIP');
assert.equal(steerJob({ type: 'LOOT' }, { ...clothes, err: 'equip: no weapon' }).type, 'LOOT');
assert.notEqual(steerJob({ type: 'STOP' }, { ...clothes, err: '' }).type, 'EQUIP');

// A v2 percept must give the same prompt as the same senses without the v2 fields.
const fixtureDir = new URL('./fixtures/', import.meta.url);
const fixtures = fs.readdirSync(fixtureDir).filter((f) => f.startsWith('v2-') && f.endsWith('.json'));
assert.ok(fixtures.length >= 3);
for (const name of fixtures) {
  const v2 = JSON.parse(fs.readFileSync(new URL(name, fixtureDir), 'utf8'));
  assert.equal(v2.v, 2, name);
  for (const key of V1_FIELDS) assert.ok(key in v2, `${name} lacks ${key}`);
  const v1 = Object.fromEntries(V1_FIELDS.map((key) => [key, v2[key]]));
  const state = { goal: 'Drink.', subtask: 'Find water.', log: [] };
  assert.equal(buildPrompt(state, v2, []), buildPrompt(state, v1, []), name);
  const senses = buildPrompt(state, v2, []).split('SENSES: ')[1];
  for (const key of ['"v"', '"inv"', '"buildings"', '"zList"', '"moodle"', '"panic01"', '"res"']) {
    assert.equal(senses.includes(`${key}:`), false, `${name} leaks ${key}`);
  }
}

console.log('decide.test.mjs ok');
