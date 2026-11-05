import assert from 'node:assert/strict';
import { extractJSON, normalize, steerJob, intentLine, zombieInside, buildPrompt } from './decide.mjs';

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
assert.equal(line, '3|WAIT|0|0||holding|hide');

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
assert.equal(planted.type, 'MOVE');
assert.equal(planted.dx, -16);
assert.equal(planted.dy, -16);

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

console.log('decide.test.mjs ok');
