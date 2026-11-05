// The verb registry, the dispatcher and the result record, driven through the harness with a
// stub player. Behaviour of each verb in the live game is not checked here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function freshBody() {
  const lua = createHarness();
  lua.autoload();
  lua.run('__players[0] = __makePlayer({ x = 10, y = 10 })');
  return lua;
}

test('every verb the bridge can send is registered', () => {
  const lua = freshBody();
  for (const verb of ['MOVE', 'EAT', 'DRINK', 'LOOT', 'EQUIP', 'CLOSEDOOR', 'CONCEAL', 'BREAKIN', 'STOP', 'WAIT']) {
    assert.equal(lua.run(`return type(LocalSurvivor.verbs.${verb})`), 'function', verb);
  }
});

test('the result record starts idle', () => {
  const lua = freshBody();
  assert.deepEqual(lua.get('LocalSurvivor.result'), { seq: 0, verb: '', status: 'idle', why: '' });
});

test('setResult fills the record', () => {
  const lua = freshBody();
  lua.call('LocalSurvivor.setResult', 4, 'EAT', 'failed', 'eat: no food');
  assert.deepEqual(lua.get('LocalSurvivor.result'), { seq: 4, verb: 'EAT', status: 'failed', why: 'eat: no food' });
});

test('a verb that sets lastError is reported as failed', () => {
  const lua = freshBody();
  lua.run('LocalSurvivor.Act.execIntent(__players[0], "1|EAT|0|0||hungry|find food")');
  assert.equal(lua.get('LocalSurvivor.lastSeq'), 1);
  assert.equal(lua.get('LocalSurvivor.lastError'), 'eat: no food');
  assert.deepEqual(lua.get('LocalSurvivor.result'), { seq: 1, verb: 'EAT', status: 'failed', why: 'eat: no food' });
  assert.equal(lua.get('LocalSurvivor.hudData.thought'), 'hungry');
  assert.equal(lua.get('LocalSurvivor.hudData.goal'), 'find food');
});

test('a verb that works is left running', () => {
  const lua = freshBody();
  lua.run('LocalSurvivor.Act.execIntent(__players[0], "2|STOP|0|0|hold on||")');
  assert.deepEqual(lua.get('LocalSurvivor.result'), { seq: 2, verb: 'STOP', status: 'running', why: '' });
  assert.deepEqual(lua.run('return __players[0].said'), ['hold on']);
});

test('an old or repeated seq is ignored', () => {
  const lua = freshBody();
  lua.run('LocalSurvivor.Act.execIntent(__players[0], "5|STOP|0|0||first|")');
  lua.run('LocalSurvivor.Act.execIntent(__players[0], "5|EAT|0|0||again|")');
  lua.run('LocalSurvivor.Act.execIntent(__players[0], "3|EAT|0|0||older|")');
  assert.equal(lua.get('LocalSurvivor.result.verb'), 'STOP');
  assert.equal(lua.get('LocalSurvivor.lastSeq'), 5);
});

test('an unknown verb behaves as WAIT', () => {
  const lua = freshBody();
  lua.run('LocalSurvivor.Act.execIntent(__players[0], "1|DANCE|0|0||ok|")');
  assert.equal(lua.get('LocalSurvivor.lastError'), '');
  assert.equal(lua.get('LocalSurvivor.travel.active'), false);
  assert.equal(lua.get('LocalSurvivor.observing'), false);
  assert.equal(lua.get('LocalSurvivor.result.verb'), 'DANCE');
});

test('WAIT starts observing and any other verb stops it', () => {
  const lua = freshBody();
  lua.run('LocalSurvivor.Act.execIntent(__players[0], "1|WAIT|0|0||look|")');
  assert.equal(lua.get('LocalSurvivor.observing'), true);
  lua.run('LocalSurvivor.Act.execIntent(__players[0], "2|STOP|0|0||done|")');
  assert.equal(lua.get('LocalSurvivor.observing'), false);
});

test('a verb added from another file is dispatched with the parsed fields', () => {
  const lua = freshBody();
  lua.run(`
    LocalSurvivor.verbs.PING = function(p, args)
      LocalSurvivor.seen = args
    end
    LocalSurvivor.Act.execIntent(__players[0], "9|PING|1|2|hi|why|goal|door-7")
  `);
  assert.deepEqual(lua.get('LocalSurvivor.seen'), {
    seq: 9, action: 'PING', a: '1', b: '2', say: 'hi', thought: 'why', goal: 'goal', target: 'door-7',
  });
  assert.equal(lua.get('LocalSurvivor.result.status'), 'running');
});

test('a line without a target field gets an empty target', () => {
  const lua = freshBody();
  lua.run(`
    LocalSurvivor.verbs.PING = function(p, args) LocalSurvivor.seen = args end
    LocalSurvivor.Act.execIntent(__players[0], "1|PING|0|0|||")
  `);
  assert.equal(lua.get('LocalSurvivor.seen.target'), '');
});

test('a verb that throws is caught and reported as failed', () => {
  const lua = freshBody();
  lua.run(`
    LocalSurvivor.verbs.BOOM = function() error("kaboom") end
    LocalSurvivor.Act.execIntent(__players[0], "1|BOOM|0|0|||")
  `);
  assert.equal(lua.get('LocalSurvivor.result.status'), 'failed');
  assert.match(lua.get('LocalSurvivor.result.why'), /kaboom/);
});

test('pollIntent reads the order file and runs it', () => {
  const lua = freshBody();
  lua.run('__files["local_intent.txt"] = "6|STOP|0|0|||"');
  lua.run('LocalSurvivor.Act.pollIntent(__players[0])');
  assert.equal(lua.get('LocalSurvivor.lastSeq'), 6);
});

test('the tick loop writes the percept and polls the order file on its cadence', () => {
  const lua = freshBody();
  lua.run('__files["local_intent.txt"] = "1|STOP|0|0|||"');
  for (let i = 0; i < 59; i++) lua.fireEvent('OnTick');
  assert.equal(lua.get('LocalSurvivor.lastSeq'), 1); // polled at tick 45
  assert.equal(lua.run('return __files["local_percept.txt"]'), undefined);
  lua.fireEvent('OnTick'); // tick 60
  const percept = JSON.parse(lua.run('return __files["local_percept.txt"]'));
  // The v1 fields the current bridge reads must all stay, in their old order. v2 adds more.
  const v1 = [
    'dead', 'x', 'y', 'z', 'hour', 'day', 'outside', 'room', 'hp', 'hunger', 'thirst', 'fatigue',
    'endurance', 'panic', 'zTotal', 'zNear', 'zClose', 'zDist', 'zDir', 'zdx', 'zdy', 'foods',
    'waters', 'bldgDir', 'bldgDist', 'weapon', 'items', 'qlen', 'reflexed', 'lastSeq', 'err',
  ];
  assert.deepEqual(Object.keys(percept).filter((k) => v1.includes(k)), v1);
  assert.equal(percept.v, 2);
  assert.equal(percept.lastSeq, 1);
  assert.equal(percept.bldgDir, 'none');
});

test('an unarmed player with a zombie close flees on a survival tick', () => {
  const lua = freshBody();
  lua.run('__zombies[1] = { getX = function() return 14 end, getY = function() return 10 end, getZ = function() return 0 end, isDead = function() return false end }');
  lua.run('__squares["2,10,0"] = { isFree = function() return true end }');
  for (let i = 0; i < 5; i++) lua.fireEvent('OnTick');
  assert.equal(lua.get('LocalSurvivor.hudData.action'), 'FLEE (reflex)');
  assert.equal(lua.get('LocalSurvivor.travel.active'), true);
});

test('Core helpers', () => {
  const lua = freshBody();
  assert.deepEqual(lua.call('LocalSurvivor.Core.split', 'a|b||c', '|'), ['a', 'b', '', 'c']);
  assert.equal(lua.call('LocalSurvivor.Core.esc', 'say "hi"\nnow'), 'say \\"hi\\" now');
  assert.equal(lua.call('LocalSurvivor.Core.n2', 3.14159), '3.14');
});
