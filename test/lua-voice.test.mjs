// The inner voice on screen (Voice.lua): reading local_voice.txt only when it changed, the 3 line
// history, the toggle and the flag files, the stream filter, and a file that is missing or empty.
// How the bubble and panel look in the game can only be seen in a live run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './lua-harness.mjs';

const V = 'LocalSurvivor.Voice';

// A player that records the overhead text. speaking is what IsSpeaking answers.
function setup() {
  const lua = createHarness();
  lua.autoload();
  lua.run(`
    local p = __makePlayer({ x = 10, y = 10 })
    p.bubbles = {}
    p.speaking = true
    function p:addLineChatElement(text, r, g, b) table.insert(self.bubbles, text) end
    function p:getChatElement() local me = self; return { IsSpeaking = function() return me.speaking end } end
    __players[0] = p
  `);
  return lua;
}
const file = (lua, text) => lua.run('__files[...] = select(2, ...)', 'local_voice.txt', text);
const poll = (lua, tick) => lua.run(`LocalSurvivor.Voice.poll(__players[0], ...)`, tick);
const lines = (lua) => lua.get('LocalSurvivor.voice.lines');
const bubbles = (lua) => lua.run('return __players[0].bubbles');
// The first read only learns what the file held, so most tests start from a primed voice.
const primed = (lua) => {
  poll(lua, 0);
};

test('Voice.lua loads and the tick loop polls it', () => {
  const lua = setup();
  assert.equal(lua.run(`return type(${V}.poll)`), 'function');
  assert.equal(lua.run(`return ${V}.POLL_EVERY`), 30);
  primed(lua);
  file(lua, 'ENTER house "hide" | I need a door that locks.');
  lua.run('LocalSurvivor.tick = 29');
  lua.fireEvent('OnTick'); // tick 30
  assert.deepEqual(lines(lua), ['I need a door that locks.']);
});

test('the voice half of the line is shown, an idle thought is shown whole', () => {
  const lua = setup();
  primed(lua);
  file(lua, 'SEARCH "look for food" | Kek, empty again.');
  poll(lua, 30);
  file(lua, 'Just walking and thinking.');
  poll(lua, 60);
  assert.deepEqual(lines(lua), ['Just walking and thinking.', 'Kek, empty again.']);
});

test('it reads on change only: the same text twice is one line and one bubble', () => {
  const lua = setup();
  primed(lua);
  file(lua, 'one');
  poll(lua, 30);
  poll(lua, 60);
  poll(lua, 90);
  assert.deepEqual(lines(lua), ['one']);
  assert.equal(lua.get('LocalSurvivor.voice.rev'), 1);
  file(lua, 'two');
  poll(lua, 120);
  assert.deepEqual(lines(lua), ['two', 'one']);
  assert.equal(lua.get('LocalSurvivor.voice.rev'), 2);
});

test('a line left in the file by the last run is not shown at start', () => {
  const lua = setup();
  file(lua, 'old line from yesterday');
  poll(lua, 0);
  assert.deepEqual(lines(lua), []);
  assert.deepEqual(bubbles(lua), []);
  file(lua, 'fresh line');
  poll(lua, 30);
  assert.deepEqual(lines(lua), ['fresh line']);
});

test('the first line after a start with no file is shown', () => {
  const lua = setup();
  poll(lua, 0); // file missing
  file(lua, 'first ever');
  poll(lua, 30);
  assert.deepEqual(lines(lua), ['first ever']);
});

test('the panel keeps the last 3 lines, newest first', () => {
  const lua = setup();
  primed(lua);
  ['a', 'b', 'c', 'd', 'e'].forEach((t, i) => {
    file(lua, t);
    poll(lua, 30 * (i + 1));
  });
  assert.deepEqual(lines(lua), ['e', 'd', 'c']);
});

test('a missing or empty file shows nothing and throws nothing', () => {
  const lua = setup();
  poll(lua, 0);
  poll(lua, 30);
  file(lua, '');
  poll(lua, 60);
  file(lua, '   ');
  poll(lua, 90);
  file(lua, ' | ');
  poll(lua, 120);
  assert.deepEqual(lines(lua), []);
  assert.deepEqual(bubbles(lua), []);
  assert.equal(lua.get('LocalSurvivor.lastError'), '');
});

test('a broken reader does not throw out of the poll', () => {
  const lua = setup();
  lua.run('getFileReader = function() error("disk gone") end');
  poll(lua, 0);
  poll(lua, 30);
  assert.deepEqual(lines(lua), []);
});

test('a broken overhead call falls back to Say and then to nothing', () => {
  const lua = setup();
  primed(lua);
  lua.run('__players[0].addLineChatElement = function() error("no such method") end');
  file(lua, 'plain say');
  poll(lua, 30);
  assert.deepEqual(lua.run('return __players[0].said'), ['plain say']);
  lua.run('__players[0].Say = function() error("also gone") end');
  file(lua, 'nothing works');
  poll(lua, 60);
  assert.deepEqual(lines(lua), ['nothing works', 'plain say']);
});

// Record what the panel draws.
function draws(lua) {
  lua.run(`
    __drawn = {}
    ISUIElement.drawText = function(self, str, x, y, r, g, b, a, font) table.insert(__drawn, { text = str, y = y, font = font, r = r }) end
  `);
}
const drawn = (lua) => lua.run('return __drawn');
const render = (lua) => lua.run(`${V}.instance:render()`);

// ---------- the bubble ----------

test('a new line makes one bubble, in the voice colour call, not a shout', () => {
  const lua = setup();
  primed(lua);
  file(lua, 'A | hello there');
  poll(lua, 30);
  assert.deepEqual(bubbles(lua), ['hello there']);
  assert.deepEqual(lua.run('return __players[0].said'), [], 'no Say, which could log or carry');
});

test('each line is said once: the game cannot be asked whether its bubble is still up', () => {
  const lua = setup();
  primed(lua);
  lua.run('__players[0].getChatElement = function() error("ChatElement is not a Lua table in 42.21") end');
  file(lua, 'hold me');
  poll(lua, 30);
  assert.equal(bubbles(lua).length, 1);
  lua.run('__players[0].speaking = false');
  poll(lua, 90);
  poll(lua, 30 + lua.get(`${V}.HOLD`));
  assert.equal(bubbles(lua).length, 1, 'never said again');
});

test('the bubble hold is 6 to 8 seconds of 60 a second ticks', () => {
  const lua = setup();
  const hold = lua.get(`${V}.HOLD`);
  assert.ok(hold >= 360 && hold <= 480, String(hold));
});

test('a long line makes a shorter bubble but the panel keeps it', () => {
  const lua = setup();
  primed(lua);
  const long = 'word '.repeat(80).trim();
  file(lua, long);
  poll(lua, 30);
  assert.ok(bubbles(lua)[0].length <= 140);
  assert.ok(bubbles(lua)[0].endsWith('...'));
  assert.ok(lines(lua)[0].length > 140);
});

test('a dead character gets the panel line but no bubble', () => {
  const lua = setup();
  primed(lua);
  lua.run('__players[0].dead = true');
  file(lua, 'it is over');
  poll(lua, 30);
  assert.deepEqual(lines(lua), ['it is over']);
  assert.deepEqual(bubbles(lua), []);
});

// ---------- the toggle and the flag ----------

test('the key toggles the bubble and the panel', () => {
  const lua = setup();
  primed(lua);
  assert.equal(lua.run(`return ${V}.visible()`), true, 'on by default');
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_SEMICOLON)');
  assert.equal(lua.run(`return ${V}.visible()`), false);
  file(lua, 'said while off');
  poll(lua, 30);
  assert.deepEqual(bubbles(lua), [], 'no bubble while off');
  assert.deepEqual(lines(lua), ['said while off'], 'history still tracks it');
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_SEMICOLON)');
  assert.equal(lua.run(`return ${V}.visible()`), true);
  file(lua, 'said while on');
  poll(lua, 60);
  assert.deepEqual(bubbles(lua), ['said while on']);
});

test('the HUD key list names the voice key and its state', () => {
  const lua = setup();
  draws(lua);
  lua.run('LocalSurvivor.HUD.start()');
  lua.run('LocalSurvivor.HUD.instance:render()');
  assert.ok(drawn(lua).some((d) => /; voice [(]on[)]/.test(d.text)));
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_SEMICOLON); __drawn = {}; LocalSurvivor.HUD.instance:render()');
  assert.ok(drawn(lua).some((d) => /; voice [(]off[)]/.test(d.text)));
});

test('ls_voice_off.txt turns both off, and removing it turns them back on', () => {
  const lua = setup();
  primed(lua);
  lua.run("__files['ls_voice_off.txt'] = 'x'");
  file(lua, 'quiet please');
  poll(lua, 30);
  assert.equal(lua.run(`return ${V}.visible()`), false);
  assert.deepEqual(bubbles(lua), []);
  lua.run("__files['ls_voice_off.txt'] = nil");
  file(lua, 'back on');
  poll(lua, 60);
  assert.equal(lua.run(`return ${V}.visible()`), true);
  assert.deepEqual(bubbles(lua), ['back on']);
});

test('the flag file wins over the key', () => {
  const lua = setup();
  primed(lua);
  lua.run("__files['ls_voice_off.txt'] = 'x'");
  poll(lua, 30);
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_SEMICOLON)'); // key off
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_SEMICOLON)'); // key on again
  assert.equal(lua.run(`return ${V}.visible()`), false, 'the file still says off');
});

// ---------- the filter ----------

test('the filter is off by default and on with ls_voice_clean.txt', () => {
  const lua = setup();
  primed(lua);
  const bad = lua.run(`return ${V}.words()[1]`);
  file(lua, `you ${bad} you`);
  poll(lua, 30);
  assert.equal(lua.get('LocalSurvivor.voice.clean'), false);
  assert.equal(bubbles(lua)[0], `you ${bad} you`, 'unfiltered by default');
  lua.run("__files['ls_voice_clean.txt'] = 'x'");
  file(lua, `you ${bad} you again`);
  poll(lua, 60);
  assert.equal(lua.get('LocalSurvivor.voice.clean'), true);
  assert.equal(bubbles(lua)[1], `you ${'*'.repeat(bad.length)} you again`);
  // The stored history keeps the truth, only the display is starred.
  assert.equal(lines(lua)[0], `you ${bad} you again`);
});

test('every word on the list is starred, in any case, and a plural too', () => {
  const lua = setup();
  const list = lua.run(`return ${V}.words()`);
  assert.ok(list.length >= 10 && list.length <= 40, 'a short list');
  for (const w of list) {
    const stars = '*'.repeat(w.length);
    assert.equal(lua.call(`${V}.cleanse`, `a ${w} b`), `a ${stars} b`, w);
    assert.equal(lua.call(`${V}.cleanse`, `a ${w.toUpperCase()}, b`), `a ${stars}, b`, w);
    assert.equal(lua.call(`${V}.cleanse`, `${w}s!`), `${stars}*!`, `${w}s`);
  }
});

test('the filter keeps the length and leaves innocent words alone', () => {
  const lua = setup();
  const same = [
    'A raccoon ate the spice in Pakistan.',
    'The classic grape, a pickaxe, therapist, Scunthorpe.',
    'Kysely is not a word on the list.',
    'Grapes and drapes, nothing here.',
    '',
  ];
  for (const t of same) assert.equal(lua.call(`${V}.cleanse`, t), t);
  const w = lua.run(`return ${V}.words()[1]`);
  const out = lua.call(`${V}.cleanse`, `x${w} ${w}x`);
  assert.equal(out, `x${w} ${w}x`, 'inside a longer word it is left');
  assert.equal(lua.call(`${V}.cleanse`, `${w} and ${w}`).length, `${w} and ${w}`.length);
});

test('the filter reaches the panel rows too', () => {
  const lua = setup();
  const w = lua.run(`return ${V}.words()[1]`);
  const rows = lua.run(`return ${V}.rows({ ... }, true, 900, function(s) return #s end)`, `hey ${w}`);
  assert.deepEqual(rows.map((r) => r.text), [`hey ${'*'.repeat(w.length)}`]);
});

// ---------- the panel ----------

test('the panel is titled Inner voice and draws newest on top, in a medium font', () => {
  const lua = setup();
  draws(lua);
  primed(lua);
  lua.run(`${V}.start()`);
  ['first', 'second', 'third', 'fourth'].forEach((t, i) => {
    file(lua, t);
    poll(lua, 30 * (i + 1));
  });
  render(lua);
  const d = drawn(lua);
  assert.equal(d[0].text, 'Inner voice');
  assert.deepEqual(d.slice(1).map((x) => x.text), ['fourth', 'third', 'second']);
  assert.ok(d.every((x) => x.font === 'Medium' || x.font === 'Large'), 'a size readable on a stream');
  const ys = d.slice(1).map((x) => x.y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b), 'top to bottom, no overlap');
  assert.ok(d[1].r > d[2].r, 'the newest is the brightest');
});

test('the panel wraps long lines and does not overlap its rows', () => {
  const lua = setup();
  draws(lua);
  primed(lua);
  lua.run(`${V}.start()`);
  file(lua, 'word '.repeat(60).trim());
  poll(lua, 30);
  render(lua);
  const body = drawn(lua).slice(1);
  assert.ok(body.length > 1, 'wrapped to several rows');
  for (let i = 1; i < body.length; i++) assert.ok(body[i].y - body[i - 1].y >= 20, 'rows at least a font height apart');
  const w = lua.run(`return ${V}.instance.width`);
  const maxChars = Math.floor((w - 24) / 9);
  assert.ok(body.every((r) => r.text.length <= maxChars), 'every row fits the panel');
  const h = lua.run(`return ${V}.instance.height`);
  assert.ok(body[body.length - 1].y + 20 <= h, 'the panel is tall enough for its rows');
});

test('the panel sits in the top right corner', () => {
  const lua = setup();
  draws(lua);
  primed(lua);
  lua.run(`${V}.start()`);
  file(lua, 'hello');
  poll(lua, 30);
  render(lua);
  const inst = lua.run(`return { x = ${V}.instance.x, y = ${V}.instance.y, w = ${V}.instance.width }`);
  assert.equal(inst.x + inst.w + 14, 1920);
  assert.equal(inst.y, 14);
});

test('the panel draws nothing when empty, toggled off or flagged off', () => {
  const lua = setup();
  draws(lua);
  primed(lua);
  lua.run(`${V}.start()`);
  render(lua);
  assert.deepEqual(drawn(lua), [], 'no lines yet');
  file(lua, 'hello');
  poll(lua, 30);
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_SEMICOLON)');
  render(lua);
  assert.deepEqual(drawn(lua), [], 'key off');
  lua.run('LocalSurvivor.HUD.onKeyPressed(Keyboard.KEY_SEMICOLON)');
  lua.run("__files['ls_voice_off.txt'] = 'x'");
  poll(lua, 60);
  render(lua);
  assert.deepEqual(drawn(lua), [], 'file off');
  lua.run("__files['ls_voice_off.txt'] = nil");
  poll(lua, 90);
  render(lua);
  assert.ok(drawn(lua).length > 0, 'back on');
});

test('the panel stars the display when the clean flag is on', () => {
  const lua = setup();
  draws(lua);
  primed(lua);
  lua.run(`${V}.start()`);
  const w = lua.run(`return ${V}.words()[1]`);
  lua.run("__files['ls_voice_clean.txt'] = 'x'");
  file(lua, `hey ${w}`);
  poll(lua, 30);
  render(lua);
  assert.equal(drawn(lua)[1].text, `hey ${'*'.repeat(w.length)}`);
  lua.run("__files['ls_voice_clean.txt'] = nil");
  poll(lua, 60);
  lua.run('__drawn = {}; LocalSurvivor.voice.rev = LocalSurvivor.voice.rev + 1');
  render(lua);
  assert.equal(drawn(lua)[1].text, `hey ${w}`, 'the stored line is untouched');
});

test('wrap cuts a word wider than the row', () => {
  const lua = setup();
  const rows = lua.run(`return ${V}.wrap(..., 50, function(s) return #s end)`, 'x'.repeat(120));
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r) => r.length <= 50));
  assert.equal(rows.join(''), 'x'.repeat(120));
});
