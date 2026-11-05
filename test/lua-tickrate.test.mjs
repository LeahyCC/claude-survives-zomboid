// The tick loop runs at about 60 a second whatever the frame rate, because every timer in the mod
// counts ticks. At a 240 fps cap the old loop ran four times too fast.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

function game() {
  const lua = createHarness();
  lua.autoload();
  lua.run(`
    __now = 1000
    getTimestampMs = function() return __now end
    __players[0] = __makePlayer({ x = 10.5, y = 10.5 })
  `);
  return lua;
}

// Run frames for a number of seconds at a frame rate and return how many ticks happened.
function ticksFor(lua, fps, seconds) {
  return lua.run(`
    local before = LocalSurvivor.tick
    for i = 1, ${fps * seconds} do
      __now = __now + 1000 / ${fps}
      LocalSurvivor.onTick()
    end
    return LocalSurvivor.tick - before
  `);
}

test('240 frames a second still gives about 60 ticks a second', () => {
  const n = ticksFor(game(), 240, 10);
  assert.ok(n >= 590 && n <= 610, `got ${n} ticks in 10 s`);
});

test('60 frames a second gives one tick a frame', () => {
  const n = ticksFor(game(), 60, 10);
  assert.ok(n >= 590 && n <= 601, `got ${n} ticks in 10 s`);
});

test('a slow PC ticks once a frame, as before', () => {
  assert.equal(ticksFor(game(), 30, 10), 300);
});

test('a long stall does not make the loop race to catch up', () => {
  const lua = game();
  ticksFor(lua, 60, 1);
  lua.run('__now = __now + 5000');
  assert.ok(ticksFor(lua, 240, 1) <= 61);
});
