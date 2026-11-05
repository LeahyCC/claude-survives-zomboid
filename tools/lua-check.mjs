// Parse every .lua file under mods/ as Lua 5.1, the dialect Kahlua runs.
// A goto, a // operator or a bitwise operator fails here instead of in a playtest.
//
//   node tools/lua-check.mjs [dir]       prints file:line: message, exits 1 on any error

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import luaparse from 'luaparse';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const start = path.resolve(process.argv[2] || path.join(root, 'mods'));

function* luaFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* luaFiles(full);
    else if (entry.name.endsWith('.lua')) yield full;
  }
}

let files = 0;
let failures = 0;
for (const file of luaFiles(start)) {
  files++;
  const rel = path.relative(root, file).split(path.sep).join('/');
  try {
    luaparse.parse(fs.readFileSync(file, 'utf8'), { luaVersion: '5.1' });
  } catch (err) {
    failures++;
    console.error(`${rel}:${err.line ?? 0}: ${String(err.message).replace(/^\[\d+:\d+\]\s*/, '')}`);
  }
}

if (files === 0) {
  console.error(`no .lua files under ${start}`);
  process.exit(1);
}
if (failures) {
  console.error(`lua-check: ${failures} of ${files} files failed`);
  process.exit(1);
}
console.log(`lua-check: ${files} files ok`);
