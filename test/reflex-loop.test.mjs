// The escape loop counter (ReflexLog.tally): FLEE, HIDE or BREAK tries that keep ending with a
// chaser still there, the call line that marks the limit, and what the percept tells the bridge.
// The rules for what she does once the limit is hit are in reflex-decide.test.mjs. The loop
// itself is the 2026-11-05 soak: one zombie, unarmed, no breath, 35 FLEEs in 33 minutes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function fresh() {
  const lua = createHarness();
  lua.autoload();
  return lua;
}
const lines = (lua) => String(lua.run('return __files["local_reflex.txt"] or ""')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const note = (lua, a, snap, tick) => lua.call('LocalSurvivor.ReflexLog.note', a, snap, tick, 0);
const chaser = (d) => ({ d, dx: d, dy: 0, chase: true });
const FLEE = { kind: 'flee', stance: 'FLEE', why: 'unarmed' };
const NONE = { kind: 'none', stance: 'NONE' };

// tally mutates the table it is given, so run it in Lua on one state and read the fields back.
function replay(lua, steps) {
  return lua.run(`
    local st = {}
    local out = {}
    for _, s in ipairs(...) do
      LocalSurvivor.ReflexLog.tally(st, s[1], s[2], s[3])
      table.insert(out, st.fails or 0)
    end
    return { fails = out, st = { fails = st.fails or 0, winStart = st.winStart, clearSince = st.clearSince } }
  `, steps);
}

test('tally: an escape try that is still chased when the next one starts is one fail', () => {
  const lua = fresh();
  const r = replay(lua, [['FLEE', false, 0], ['FLEE', false, 100], ['FLEE', false, 300], ['FLEE', false, 400], ['FLEE', false, 600]]);
  assert.deepEqual(r.fails, [0, 0, 1, 1, 2], 'a fail every 300 ticks of escaping while chased');
});

test('tally: only FLEE, HIDE and BREAK are tries. Standing, fighting and doing nothing are not', () => {
  const lua = fresh();
  const r = replay(lua, [['FLEE', false, 0], ['NONE', false, 400], ['HOLD', false, 800], ['FIGHT', false, 900], ['SHOVE', false, 1000]]);
  assert.deepEqual(r.fails, [0, 0, 0, 0, 0]);
  const r2 = replay(lua, [['HIDE', false, 0], ['BREAK', false, 300], ['FLEE', false, 600]]);
  assert.deepEqual(r2.fails, [0, 1, 2], 'the three escapes share one tally');
});

test('tally: a spell with nothing chasing ends the loop, a blink does not', () => {
  const lua = fresh();
  const blink = replay(lua, [['FLEE', false, 0], ['FLEE', false, 300], ['NONE', true, 400], ['NONE', true, 500], ['FLEE', false, 600]]);
  assert.deepEqual(blink.fails, [0, 1, 1, 1, 2], 'two seconds clear is not an escape');
  const gone = replay(lua, [['FLEE', false, 0], ['FLEE', false, 300], ['NONE', true, 400], ['NONE', true, 585], ['FLEE', false, 600]]);
  assert.deepEqual(gone.fails, [0, 1, 1, 0, 0], '180 ticks clear: start again');
  assert.equal(gone.st.winStart, 600, 'and the new try is the first');
});

test('the soak loop: four minutes of FLEE calls a minute apart hit the limit on the fourth, and it is called out once', () => {
  const lua = fresh();
  const logTick = (t) => lua.call('LocalSurvivor.ReflexLog.flush', t);
  const st = () => lua.get('LocalSurvivor.reflexLog');
  // 12:44:25, 12:45:26, 12:48:52, 12:49:04: a FLEE at 5.3 tiles, nothing in between but a zombie 8.4 off.
  const at = [100, 3760, 24400, 25120];
  const fails = [];
  for (const t of at) {
    note(lua, FLEE, { zombies: [chaser(5.3)], armed: false, endurance: 0, hp: 100 }, t);
    note(lua, NONE, { zombies: [chaser(8.4)] }, t + 300);
    fails.push(st().fails || 0);
  }
  assert.deepEqual(fails, [0, 1, 2, 3]);
  // The decision after the third fail is the loop breaker. The runner passes what Stance.choose says.
  const stuck = { kind: 'flee', stance: 'FLEE', why: 'stuck:unarmed', stuck: 3, handoff: true };
  note(lua, stuck, { zombies: [chaser(5.2)], armed: false, endurance: 0, hp: 100 }, 25200);
  note(lua, stuck, { zombies: [chaser(5.4)] }, 25205);
  note(lua, stuck, { zombies: [chaser(5.6)] }, 25210);
  logTick(25210);
  const calls = lines(lua).filter((l) => l.t === 'call' && l.why === 'stuck:unarmed');
  assert.equal(calls.length, 1, 'one call marks the limit, not one per tick');
  assert.equal(calls[0].stuck, 3);
  assert.equal(calls[0].stance, 'FLEE', 'still a FLEE, so the log shows she kept running');
  assert.equal(calls[0].f.chasers, 1);
  const sum = lua.call('LocalSurvivor.ReflexLog.summary', st(), 25210);
  assert.equal(sum.fails, 3);
  assert.equal(sum.stuck, true, 'the bridge reads this to hand her a turn');
});

test('a way out the reflex has itself is called out too, but does not ask for the brain', () => {
  const lua = fresh();
  lua.run('LocalSurvivor.reflexLog.fails = 3');
  const stand = { kind: 'hold', stance: 'HOLD', why: 'stuck:unarmed', stuck: 3 };
  note(lua, stand, { zombies: [chaser(5.3)] }, 100);
  lua.call('LocalSurvivor.ReflexLog.flush', 100);
  const call = lines(lua).find((l) => l.t === 'call');
  assert.deepEqual([call.stance, call.act, call.why, call.stuck], ['HOLD', 'hold', 'stuck:unarmed', 3]);
  const sum = lua.call('LocalSurvivor.ReflexLog.summary', lua.get('LocalSurvivor.reflexLog'), 100);
  assert.equal(sum.stuck, false);
  assert.equal(sum.fails, 3);
});

test('once the chase is over the tally and the flag are cleared, and a later loop is called out again', () => {
  const lua = fresh();
  lua.run('LocalSurvivor.reflexLog.fails = 3');
  const stuck = { kind: 'flee', stance: 'FLEE', why: 'stuck:unarmed', stuck: 3, handoff: true };
  note(lua, stuck, { zombies: [chaser(5)] }, 100);
  assert.equal(lua.get('LocalSurvivor.reflexLog.handoff'), true);
  // Nothing chasing for 3 seconds.
  note(lua, NONE, { zombies: [] }, 200);
  note(lua, NONE, { zombies: [] }, 400);
  const st = lua.get('LocalSurvivor.reflexLog');
  assert.equal(st.fails, 0);
  assert.equal(st.stuckOpen, false);
  assert.equal(st.handoff, false);
  lua.run('LocalSurvivor.reflexLog.fails = 3');
  note(lua, stuck, { zombies: [chaser(5)] }, 500);
  lua.call('LocalSurvivor.ReflexLog.flush', 500);
  assert.equal(lines(lua).filter((l) => l.t === 'call' && l.why === 'stuck:unarmed').length, 2);
});

test('the same stance is a call again when it is marked stuck, once, and a plain one still is not', () => {
  const lua = fresh();
  const isNew = (st, why) => lua.call('LocalSurvivor.ReflexLog.isNewCall', st, 'FLEE', 10, why);
  const st = { lastStance: 'FLEE', lastActTick: 5 };
  assert.equal(isNew(st, 'unarmed'), false);
  assert.equal(isNew(st, 'stuck:unarmed'), true);
  assert.equal(isNew({ ...st, stuckOpen: true }, 'stuck:unarmed'), false);
});

test('the survival tick runs the loop end to end: unarmed, no breath, chased, minute after minute', () => {
  const lua = fresh();
  lua.run(`
    local p = __makePlayer({ x = 10, y = 10, stats = { ENDURANCE = 0 } })
    p.isSneaking = function() return false end
    p.isAttackStarted = function() return false end
    p.isAuthorizeShoveStomp = function() return true end
    p.setDoShove = function() end
    p.DoAttack = function() end
    p.setSprinting = function() end
    p.isSprinting = function() return false end
    __players[0] = p
    table.insert(__zombies, {
      getX = function() return 15.3 end, getY = function() return 10 end, getZ = function() return 0 end,
      isDead = function() return false end, isOnFloor = function() return false end,
      isKnockedDown = function() return false end, isFakeDead = function() return false end,
      isCrawling = function() return false end, isOutside = function() return true end,
      getTarget = function() return __players[0] end,
    })
  `);
  const whys = [];
  for (const t of [100, 3700, 7300, 10900, 14500]) {
    lua.run('LocalSurvivor.tick = ...; LocalSurvivor.Reflex.survive(__players[0])', t);
    whys.push(lua.get('LocalSurvivor.reflexLog.lastWhy'));
  }
  // The tally is read before a decision and added to after it: the fourth try is the first to know.
  assert.deepEqual(whys, ['unarmed', 'unarmed', 'unarmed', 'unarmed', 'stuck:unarmed']);
  lua.call('LocalSurvivor.ReflexLog.flush', 14500);
  const stuck = lines(lua).filter((l) => l.t === 'call' && l.why === 'stuck:unarmed');
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].f.endurance, 0);
  lua.run('LocalSurvivor.Sense.writePercept(__players[0])');
  const percept = JSON.parse(lua.run('return __files["local_percept.txt"]'));
  assert.equal(percept.reflex.stuck, true);
  assert.ok(percept.reflex.fails >= 3, 'the walk on is still a try, so the tally keeps rising');
});
