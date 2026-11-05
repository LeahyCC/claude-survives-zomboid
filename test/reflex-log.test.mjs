// The reflex log (ReflexLog.lua): a call line when the stance changes, an outcome line five
// seconds later, the file it goes to, and the summary the percept carries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function fresh() {
  const lua = createHarness();
  lua.autoload();
  return lua;
}
const lines = (lua) => String(lua.run('return __files["local_reflex.txt"] or ""')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const note = (lua, a, snap, tick, kills = 0, sprint) => lua.call('LocalSurvivor.ReflexLog.note', a, snap, tick, kills, sprint);
const chaser = (d) => ({ d, dx: d, dy: 0, chase: true });

test('a call is a new stance, or the same one after a quiet spell', () => {
  const lua = fresh();
  const isNew = (st, stance, tick) => lua.call('LocalSurvivor.ReflexLog.isNewCall', st, stance, tick);
  assert.equal(isNew({ lastStance: 'NONE', lastActTick: -99999 }, 'NONE', 10), false);
  assert.equal(isNew({ lastStance: 'NONE', lastActTick: -99999 }, 'FIGHT', 10), true);
  assert.equal(isNew({ lastStance: 'FIGHT', lastActTick: 5 }, 'FIGHT', 10), false);
  assert.equal(isNew({ lastStance: 'FIGHT', lastActTick: 5 }, 'SHOVE', 10), true);
  assert.equal(isNew({ lastStance: 'FIGHT', lastActTick: 5 }, 'FIGHT', 200), true);
});

test('facts count what matters and escaped is the bridge hold line', () => {
  const lua = fresh();
  const f = lua.call('LocalSurvivor.ReflexLog.facts', {
    zombies: [chaser(2), { d: 6, chase: true, sees: false }, { d: 9, chase: false }, { d: 1, down: true }, chaser(12)],
    armed: true, weaponScore: 34, endurance: 0.42, hp: 80, bleeding: 1, load: 0.5, inside: false, posture: 'avoid',
    lines: [{ dx: 1, dy: 0 }, { dx: 0, dy: 1, blocked: true }], barriers: [{ kind: 'fence' }],
  });
  assert.equal(f.chasers, 2);
  assert.equal(f.seen, 1);
  assert.equal(f.within3, 1);
  assert.equal(f.downed, 1);
  assert.equal(f.unaware, 1);
  assert.equal(f.near, 1);
  assert.equal(f.open, 1);
  assert.equal(f.lines, 2);
  assert.equal(f.barriers, 1);
  assert.equal(f.posture, 'avoid');
  const esc = (x) => lua.call('LocalSurvivor.ReflexLog.escaped', x);
  assert.equal(esc({ chasers: 0, within3: 0 }), true);
  assert.equal(esc({ chasers: 1, within3: 0 }), false);
  assert.equal(esc({ chasers: 0, within3: 1 }), false);
});

test('a call line, then its outcome five seconds later with hp lost, hits and kills', () => {
  const lua = fresh();
  const breakA = { kind: 'break', stance: 'BREAK', why: 'pack', threat: 4.2, level: 4 };
  note(lua, breakA, { zombies: [chaser(3), chaser(4), chaser(5)], hp: 90 }, 100, 2, false);
  // Two hits while she runs, one is a bite (over the hit line), one a small graze.
  lua.call('LocalSurvivor.ReflexLog.health', 3.5, 120);
  lua.call('LocalSurvivor.ReflexLog.health', 0.1, 121);
  note(lua, breakA, { zombies: [chaser(6)] }, 105, 2, true);
  lua.call('LocalSurvivor.ReflexLog.flush', 160);
  let out = lines(lua);
  assert.equal(out.length, 1);
  assert.equal(out[0].t, 'call');
  assert.equal(out[0].stance, 'BREAK');
  assert.equal(out[0].act, 'break');
  assert.equal(out[0].why, 'pack');
  assert.equal(out[0].level, 4);
  assert.equal(out[0].f.chasers, 3);
  // 300 ticks on: she got away.
  note(lua, { kind: 'none', stance: 'NONE' }, { zombies: [{ d: 14, chase: true }] }, 400, 3);
  lua.call('LocalSurvivor.ReflexLog.flush', 400);
  out = lines(lua);
  assert.equal(out.length, 2);
  const o = out[1];
  assert.equal(o.t, 'out');
  assert.equal(o.id, out[0].id);
  assert.equal(o.escaped, true);
  assert.equal(o.chased, false);
  assert.equal(o.hits, 1);
  assert.equal(o.hpLost, 3.6);
  assert.equal(o.kills, 1);
  assert.equal(o.secs, 5);
  assert.equal(o.next, 'NONE');
  assert.equal(o.sprint, true, 'the game kept the sprint at least once');
  const sum = lua.call('LocalSurvivor.ReflexLog.summary', lua.get('LocalSurvivor.reflexLog'), 400);
  assert.deepEqual(
    { stance: sum.stance, calls: sum.calls, escapes: sum.escapes, outcomes: sum.outcomes, hits60: sum.hits60 },
    { stance: 'BREAK', calls: 1, escapes: 1, outcomes: 1, hits60: 1 },
  );
  assert.equal(lua.call('LocalSurvivor.ReflexLog.summary', lua.get('LocalSurvivor.reflexLog'), 5000).hits60, 0, 'a minute later');
});

test('a fight that is still on after five seconds is not an escape', () => {
  const lua = fresh();
  note(lua, { kind: 'swing', stance: 'FIGHT' }, { zombies: [chaser(1.2)] }, 0);
  note(lua, { kind: 'swing', stance: 'FIGHT' }, { zombies: [chaser(1.2)] }, 300);
  lua.call('LocalSurvivor.ReflexLog.flush', 300);
  const o = lines(lua).find((l) => l.t === 'out');
  assert.equal(o.escaped, false);
  assert.equal(o.chased, true);
  assert.equal(o.next, 'FIGHT');
  assert.equal(o.sprint, undefined);
});

test('the file starts again each session and past its cap, and is appended to between', () => {
  const lua = fresh();
  lua.run('__files["local_reflex.txt"] = "old session\\n"');
  note(lua, { kind: 'swing', stance: 'FIGHT' }, { zombies: [chaser(1)] }, 0);
  lua.call('LocalSurvivor.ReflexLog.flush', 0);
  assert.equal(lines(lua).length, 1, 'the old session is gone');
  note(lua, { kind: 'shove', stance: 'SHOVE' }, { zombies: [chaser(1)] }, 10);
  lua.call('LocalSurvivor.ReflexLog.flush', 10);
  assert.equal(lines(lua).length, 2, 'appended');
  lua.set('LocalSurvivor.ReflexLog.MAX_BYTES', 50);
  note(lua, { kind: 'swing', stance: 'FIGHT' }, { zombies: [chaser(1)] }, 20);
  lua.call('LocalSurvivor.ReflexLog.flush', 20);
  assert.equal(lines(lua).length, 1, 'over the cap: a fresh file');
});

test('the survival tick logs the call and the percept carries the summary', () => {
  const lua = fresh();
  lua.run(`
    local p = __makePlayer({ x = 10, y = 10, stats = { ENDURANCE = 1 } })
    function p:isMeleeWeaponEquipped() return true end
    p.primary = __makeItem({ type = "Base.Crowbar", name = "Crowbar", melee = true, dmg = 1.15, crit = 20, range = 1.25,
      swing = 3, twoHand = true, cls = { "BLUNT" }, weight = 2 })
    function p:isAttackStarted() return false end
    function p:isAuthorizeShoveStomp() return true end
    function p:setDoShove() end
    function p:DoAttack() end
    __players[0] = p
    table.insert(__zombies, {
      getX = function() return 11.2 end, getY = function() return 10 end, getZ = function() return 0 end,
      isDead = function() return false end, isOnFloor = function() return false end,
      getTarget = function() return __players[0] end,
    })
    LocalSurvivor.tick = 100
    LocalSurvivor.Reflex.survive(p)
    LocalSurvivor.ReflexLog.flush(100)
  `);
  const call = lines(lua)[0];
  assert.equal(call.stance, 'FIGHT');
  assert.equal(call.act, 'swing');
  assert.equal(call.f.armed, true);
  assert.ok(call.f.score > 20, `the crowbar's score, got ${call.f.score}`);
  lua.run('LocalSurvivor.Sense.writePercept(__players[0])');
  const percept = JSON.parse(lua.run('return __files["local_percept.txt"]'));
  assert.equal(percept.reflex.stance, 'FIGHT');
  assert.equal(percept.reflex.calls, 1);
  assert.equal(percept.reflex.posture, 'normal');
  assert.equal(typeof percept.reflex.hits60, 'number');
});

test('watchHealth feeds the hits', () => {
  const lua = fresh();
  lua.run(`
    local p = __makePlayer({ x = 10, y = 10 })
    __players[0] = p
    LocalSurvivor.tick = 50
    p.hp = 100; LocalSurvivor.Reflex.watchHealth(p)
    p.hp = 96; LocalSurvivor.Reflex.watchHealth(p)
    p.hp = 95.95; LocalSurvivor.Reflex.watchHealth(p)
  `);
  const st = lua.get('LocalSurvivor.reflexLog');
  assert.equal(st.hitTotal, 1);
  assert.ok(Math.abs(st.lost - 4.05) < 0.001);
});
