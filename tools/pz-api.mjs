// List the public methods a Project Zomboid Java class really has, straight from the game jar.
// Lua calls into Java by method name, and a wrong name fails silently inside pcall.
//
//   node tools/pz-api.mjs zombie.characters.IsoPlayer          every public method, walking up the parents
//   node tools/pz-api.mjs zombie.characters.IsoPlayer shove    only names matching a regex
//
// Set PZ_HOME if the game is not at M:/SteamLibrary/steamapps/common/ProjectZomboid.
// Needs `unzip` on PATH (Git Bash has it).

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PZ_HOME = process.env.PZ_HOME || 'M:/SteamLibrary/steamapps/common/ProjectZomboid';
const JAR = path.join(PZ_HOME, 'projectzomboid.jar');

const [start, pattern] = process.argv.slice(2);
if (!start) {
  console.error('usage: node tools/pz-api.mjs <java.class.Name> [regex]');
  process.exit(1);
}
const re = pattern ? new RegExp(pattern, 'i') : null;

// Minimal class-file reader: constant pool, skip fields, then the methods table.
function readClass(cls) {
  let bytes;
  try {
    bytes = execFileSync('unzip', ['-p', JAR, cls.replace(/\./g, '/') + '.class'], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  if (bytes.length < 10 || bytes.readUInt32BE(0) !== 0xcafebabe) return null;

  let pos = 8;
  const u1 = () => bytes[pos++];
  const u2 = () => { const v = bytes.readUInt16BE(pos); pos += 2; return v; };
  const u4 = () => { const v = bytes.readUInt32BE(pos); pos += 4; return v; };

  const count = u2();
  const pool = new Array(count);
  for (let i = 1; i < count; i++) {
    const tag = u1();
    if (tag === 1) {
      const len = u2();
      pool[i] = bytes.toString('utf8', pos, pos + len);
      pos += len;
    } else if ([7, 8, 16, 19, 20].includes(tag)) {
      pool[i] = { ref: u2() };
    } else if (tag === 15) {
      pos += 3;
    } else if ([3, 4, 9, 10, 11, 12, 17, 18].includes(tag)) {
      pos += 4;
    } else if (tag === 5 || tag === 6) {
      pos += 8;
      i++;
    } else {
      throw new Error(`${cls}: unknown constant tag ${tag}`);
    }
  }
  const className = (idx) => pool[pool[idx].ref].replace(/\//g, '.');

  pos += 2; // access flags
  const self = className(u2());
  const superIdx = u2();
  const parent = superIdx ? className(superIdx) : '';
  const interfaces = u2();
  pos += interfaces * 2;

  const skipAttributes = () => {
    const n = u2();
    for (let i = 0; i < n; i++) {
      pos += 2;
      // Read the length first: `pos += u4()` reads pos before u4 moves it.
      const len = u4();
      pos += len;
    }
  };
  const fields = u2();
  for (let i = 0; i < fields; i++) {
    pos += 6;
    skipAttributes();
  }

  const methods = new Set();
  const total = u2();
  for (let i = 0; i < total; i++) {
    const flags = u2();
    const name = pool[u2()];
    const desc = pool[u2()];
    skipAttributes();
    if (!(flags & 0x0001) || name.startsWith('<') || name.includes('$')) continue;
    if (re && !re.test(name)) continue;
    methods.add(`${flags & 0x0008 ? 'static ' : ''}${name}${desc}`);
  }
  return { self, parent, methods: [...methods].sort() };
}

// Walk up the parents. Most useful methods live on IsoGameCharacter, IsoMovingObject, IsoObject.
let name = start;
let found = false;
while (name && !name.startsWith('java.')) {
  const info = readClass(name);
  if (!info) {
    if (!found) {
      console.error(`${name} not found in ${JAR}`);
      process.exit(1);
    }
    break;
  }
  found = true;
  console.log(`== ${info.self} extends ${info.parent}`);
  console.log(info.methods.join('\n') || '(no public methods match)');
  name = info.parent;
}
