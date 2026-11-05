// List the names inside a Project Zomboid class file, to check an enum constant before Lua uses it.
// pz-api.mjs lists methods. Enum values like MoodleType.THIRST or IsoFlagType.bed are fields,
// and a wrong one is nil in Lua with no error.
//
//   node tools/pz-consts.mjs zombie.scripting.objects.MoodleType "^[A-Z_]+$"
//
// Set PZ_HOME if the game is not at M:/SteamLibrary/steamapps/common/ProjectZomboid.
// Needs `unzip` on PATH (Git Bash has it).

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PZ_HOME = process.env.PZ_HOME || 'M:/SteamLibrary/steamapps/common/ProjectZomboid';
const JAR = path.join(PZ_HOME, 'projectzomboid.jar');

const [cls, pattern] = process.argv.slice(2);
if (!cls) {
  console.error('usage: node tools/pz-consts.mjs <java.class.Name> [regex]');
  process.exit(1);
}
const re = new RegExp(pattern || '.');

let bytes;
try {
  bytes = execFileSync('unzip', ['-p', JAR, cls.replace(/\./g, '/') + '.class'], { maxBuffer: 64 * 1024 * 1024 });
} catch {
  console.error(`not found: ${cls}`);
  process.exit(1);
}
// The constant pool holds every field name as plain UTF-8, so printable runs are enough here.
const names = new Set();
let run = '';
for (const c of bytes) {
  if (c >= 32 && c < 127) run += String.fromCharCode(c);
  else {
    if (run.length >= 2) names.add(run);
    run = '';
  }
}
console.log([...names].filter((s) => re.test(s)).sort().join('\n'));
