// Unattended soak test: keeps the game and the bridge running for a few hours, lets the helper
// mod respawn her after each death, restarts the game if it dies or stalls, and writes the review
// report at the end. Normal loot: it never sets -RichLoot.
//
//   node tools/soak.mjs [--hours 3]
//
// Reads TYPESAFE_API_KEY from the environment for the critic, like the bridge. Logs to
// bridge/soak.log and writes bridge/soak-<start>.txt with the review when it ends.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LUA_DIR = path.join(process.env.USERPROFILE || '', 'Zomboid', 'Lua');
const PERCEPT = path.join(LUA_DIR, 'local_percept.txt');
const AUTOLOAD = path.join(LUA_DIR, 'ls_autoload.txt');
const LOG = path.join(REPO, 'bridge', 'soak.log');

const args = process.argv.slice(2);
const hoursArg = args.indexOf('--hours');
const HOURS = hoursArg >= 0 ? Number(args[hoursArg + 1]) : 3;
if (!Number.isFinite(HOURS) || HOURS <= 0) throw new Error('--hours must be a positive number');

const CHECK_MS = 30_000;
// A percept older than this, with the game up, means it hangs in a menu or a loading screen.
const STALE_MS = 4 * 60_000;
const startedAt = new Date();
const endAt = startedAt.getTime() + HOURS * 3_600_000;

function log(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  fs.appendFileSync(LOG, line);
  process.stdout.write(line);
}

function gameRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ProjectZomboid64.exe', '/NH'], { encoding: 'utf8' });
  return /ProjectZomboid64\.exe/i.test(r.stdout || '');
}

function perceptAgeMs() {
  try { return Date.now() - fs.statSync(PERCEPT).mtimeMs; } catch { return Infinity; }
}

// The helper mod respawns a dead survivor only while this flag exists, and playtest.ps1 deletes
// it once the game is in, so it goes back after every launch.
function armRespawn() {
  try { fs.writeFileSync(AUTOLOAD, '1\n'); } catch (e) { log(`could not write the respawn flag: ${e.message}`); }
}

function launchGame() {
  log('launching the game (normal loot)');
  spawnSync('taskkill', ['/IM', 'ProjectZomboid64.exe', '/F'], { encoding: 'utf8' });
  const r = spawnSync('pwsh', ['-NoProfile', '-File', path.join(REPO, 'tools', 'playtest.ps1')], { encoding: 'utf8', timeout: 15 * 60_000 });
  log(`playtest.ps1: ${String(r.stdout || '').trim().split('\n').pop() || r.status}`);
  armRespawn();
}

let bridge = null;
function startBridge() {
  log('starting the bridge');
  const out = fs.openSync(path.join(REPO, 'bridge', 'soak-bridge.log'), 'a');
  bridge = spawn(process.execPath, ['pz-bridge.mjs'], { cwd: path.join(REPO, 'bridge'), stdio: ['ignore', out, out], env: process.env });
  bridge.on('exit', (code) => { log(`bridge exited (${code})`); bridge = null; });
}

function writeReport() {
  const since = startedAt.toISOString();
  const r = spawnSync(process.execPath, [path.join(REPO, 'bridge', 'tools', 'review.mjs'), '--since', since], { cwd: REPO, encoding: 'utf8' });
  const file = path.join(REPO, 'bridge', `soak-${since.slice(0, 16).replace(/[:T]/g, '-')}.txt`);
  fs.writeFileSync(file, `Soak test from ${since} for ${HOURS} h\n\n${r.stdout || ''}${r.stderr || ''}`);
  log(`report written: ${file}`);
}

log(`soak test starts, ${HOURS} h, until ${new Date(endAt).toISOString()}${process.env.TYPESAFE_API_KEY ? '' : ' (no TYPESAFE_API_KEY: critic off)'}`);
try { fs.rmSync(path.join(LUA_DIR, 'ls_loot.txt'), { force: true }); } catch { /* not there */ }
launchGame();
startBridge();

let restarts = 0;
while (Date.now() < endAt) {
  await new Promise((r) => setTimeout(r, CHECK_MS));
  if (!gameRunning()) {
    restarts += 1;
    log(`game is not running (restart ${restarts})`);
    launchGame();
  } else if (perceptAgeMs() > STALE_MS) {
    restarts += 1;
    log(`no senses for ${Math.round(perceptAgeMs() / 1000)} s with the game up, restarting it (restart ${restarts})`);
    launchGame();
  }
  if (!bridge) startBridge();
}

log(`time is up after ${HOURS} h, ${restarts} game restarts`);
writeReport();
if (bridge) bridge.kill();
try { fs.rmSync(AUTOLOAD, { force: true }); } catch { /* gone */ }
log('soak test done; the game is left running');
