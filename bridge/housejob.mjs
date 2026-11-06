// The house job. The menu used to ask afresh every turn, so nothing held "finish this house": 63
// of 168 ENTER orders came from inside another house, and only 14 of 79 entries got a SEARCH
// (docs/pro-rules.md). The bridge now holds one job across turns, in map memory:
//
//   IN      walking to the house and getting inside
//   SHUT    SECURE: doors, windows, curtains, lights
//   LOOK    listen a moment for zombies in the house
//   CLEAR   kill the one idle zombie in it, when she is fit to, then LOOK again
//   SEARCH  SEARCH until no room worth it is left
//   LEAVE   walk to the door she came in by, then on to the next house
//
// While a job is open and nothing threatens her, the menu has no ENTER elsewhere and no walk away,
// and the policy sends the order of the stage. The reflex still owns any danger. A real threat
// pauses the job while she stays inside and ends it if it drives her out. docs/brain.md has the rules.

import { zombies, reaches, chasing, heavy, isNight, inside, running, heldGun, REACH_CHASE_R, STRONG_WEAPON } from './senses.mjs';
import { blockedWhy, building, securedThisVisit, baseBuilding, withinBaseWalk } from './memory.mjs';
import { dist, compass } from './geom.mjs';
import { tiles, count } from './words.mjs';
import { crowdOfBuilding, isCrowded, areaCrowded } from './crowd.mjs';

export const STAGES = ['IN', 'SHUT', 'LOOK', 'CLEAR', 'SEARCH', 'LEAVE'];
// All in game hours. Guides say "two hours of looting, not twelve" (BG42.20). 30 a room, not 15:
// at the default day length 15 game minutes is about 37 real seconds, short for a full kitchen.
const MIN = 1 / 60;
export const PER_ROOM = 30 * MIN;
export const MIN_LIMIT = 60 * MIN;
export const MAX_LIMIT = 240 * MIN;
const WALK_LIMIT = 60 * MIN;
export const LOOK_MIN = 2 * MIN;
export const LOOK_MAX = 10 * MIN;
export const STALL_MAX = 10 * MIN;
export const LEAVE_MAX = 15 * MIN;
export const CLEAR_MAX = 20 * MIN;
export const CLEAR_MIN_HP = 70;
// The reflex stands and waits with a blade shorter than this (Reflex.shortBlade). An idle zombie
// never comes, so she would stand two tiles from it until the order timed out.
const SHORT_REACH = 1;
// A gap longer than this in the clock is the game closed or a fast forward, not time spent on the job.
const MAX_GAP = 0.5;
export const PACK_N = 3;
const PACK_R = 8;
const SEARCH_R = 8;
export const MAX_REENTRIES = 2;
const DUSK_HOUR = 17;
// A house she gave up on is not "the next house" again for this long. The guides' refill timer.
export const REVISIT_HOURS = 12;
export const CROWD_ZOMBIES = 3;
// Close enough to the door: she has done the walk.
const AT_EXIT_R = 2;
const MAX_EVENTS = 50;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const here = (p) => (inside(p) ? String(p.inBldg.id) : null);
const roomsLeftOf = (p) => (inside(p) && typeof p.inBldg.roomsLeft === 'number' && Number.isFinite(p.inBldg.roomsLeft) ? Math.max(0, Math.floor(p.inBldg.roomsLeft)) : null);

export function openJob(mem) {
  return (mem && mem.job) || null;
}

// A saved job is only trusted when it still reads as one.
export function validJob(j) {
  return !!j && typeof j === 'object' && typeof j.id === 'string' && STAGES.includes(j.stage);
}

function event(mem, e) {
  mem.jobEvents = [...(mem.jobEvents || []), e].slice(-MAX_EVENTS);
}

// The stage changes since the last call, for the decision log. review.mjs counts them.
export function drainJobEvents(mem) {
  const out = mem.jobEvents || [];
  mem.jobEvents = [];
  return out;
}

// What stops the job from holding the menu. Empty when nothing does. A chaser far off that she has
// already shaken does not count, as with SEARCH (senses.mjs, reaches).
export function jobThreat(p) {
  if (!p) return '';
  const zs = zombies(p);
  if (zs.some((z) => z.chase && z.d <= REACH_CHASE_R) || (!Array.isArray(p.zList) && chasing(p) > 0)) return 'chased';
  if (zs.filter((z) => !z.down && !z.crawl && reaches(z, PACK_R)).length >= PACK_N) return 'pack';
  if (num(p.bleeding) > 0) return 'bleeding';
  if (isNight(p) && !inside(p)) return 'night outside';
  return '';
}

export function jobLimit(rooms) {
  const n = num(rooms);
  if (n <= 0) return WALK_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n * PER_ROOM));
}

function begin(mem, id, stage, p, revisit) {
  const job = {
    id, stage, stageAt: 0, spent: 0, lastHours: num(p && p.hoursAlive), rooms: 0, leftStart: null, left: null,
    reentries: 0, revisit: !!revisit, entry: null, arrived: stage !== 'IN', backTo: null, paused: '', stall: 0,
  };
  mem.job = job;
  event(mem, { kind: 'open', bldg: id, stage, revisit: !!revisit, hours: job.lastHours });
  if (stage !== 'IN') arrive(job, p);
  return job;
}

function arrive(job, p) {
  const why = String((p.res && p.res.verb === 'ENTER' && p.res.why) || '');
  const how = /^in by a door/.test(why) ? 'door' : /^in through/.test(why) ? 'window' : 'unknown';
  job.entry = { x: Math.floor(num(p.x)), y: Math.floor(num(p.y)), how };
  job.rooms = num(p.inBldg && p.inBldg.rooms);
  job.leftStart = roomsLeftOf(p);
  job.left = job.leftStart;
  job.arrived = true;
}

function setStage(mem, job, stage, why) {
  event(mem, { kind: 'stage', bldg: job.id, from: job.stage, stage, why, left: job.left, hours: job.lastHours });
  job.stage = stage;
  job.stageAt = job.spent;
  job.stall = 0;
}

// finished means she got as far as LEAVE, whichever way it went from there.
function endJob(mem, why) {
  const job = mem.job;
  if (!job) return;
  const finished = job.stage === 'LEAVE';
  const b = building(mem, job.id);
  // A house left with rooms in it is not the next house to walk back to. One she only left because
  // her arms were full is the opposite: there is more to take, once the load is off.
  if (b && job.arrived && !b.searched) {
    if (job.leftFull) {
      b.fullAt = job.lastHours;
      delete b.leftAt;
    } else b.leftAt = job.lastHours;
  }
  const roomsSearched = job.leftStart !== null && job.left !== null ? Math.max(0, job.leftStart - job.left) : 0;
  event(mem, {
    kind: 'end', bldg: job.id, stage: job.stage, why, finished, rooms: job.rooms, roomsSearched,
    reentries: job.reentries, minutes: Math.round(job.spent * 60), hours: job.lastHours,
  });
  mem.job = null;
}

// A character died or the save changed. The job goes with the character.
export function dropJob(mem, why) {
  endJob(mem, why);
}

// Why she should not go and kill what is in this house, or '' when she should. Not as wide as the
// reflex's fight rules: this is a fight she picks. The last line is what the reflex itself will not
// fight through (Stance.gate): she would walk up to it and it would back her off, again and again.
export function clearBlock(p) {
  const here = zombies(p).filter((z) => z.inside);
  if (!here.length) return 'nobody inside';
  if (chasing(p) > 0) return 'chased';
  if (String(p.weapon || 'none') === 'none' || heldGun(p)) return 'no melee weapon';
  const held = (Array.isArray(p.weapons) ? p.weapons : []).find((w) => w && w.n === p.weapon);
  if (held && Number.isFinite(held.reach) && held.reach < SHORT_REACH) return 'weapon too short';
  if (here.length > (num(p.weaponScore) >= STRONG_WEAPON ? 2 : 1)) return 'too many inside';
  if (num(p.hp, 100) < CLEAR_MIN_HP) return 'hurt';
  if (num(p.bleeding) > 0) return 'bleeding';
  const m = p.moodle || {};
  if (num(p.endurance, 1) < 0.3 || num(m.panic) >= 3 || num(m.heavy) >= 2 || (num(m.tired) >= 3 && here.length > 1)) return 'not fit to fight';
  return '';
}

const canClear = (mem, job, p, now) => !clearBlock(p) && !blockedWhy(mem, `CLEAR:${job.id}`, now);

// The order's result is read from the percept, so one left there from an earlier CLEAR must not count.
function toClear(mem, job, p) {
  job.clearSeq = num(p.res && p.res.seq);
  setStage(mem, job, 'CLEAR', 'idle zombie inside');
}

const standingInHouse = (p) => zombies(p).filter((z) => z.inside && !z.down && !z.crawl).length;

// Too full to search and nothing more to be done about it in this house. Soak 3: 9 of 32 unsearched
// houses went to LEAVE this way. With a base in reach the load goes home, and this house waits.
function fullHere(mem, job, p, now) {
  const base = baseBuilding(mem);
  const canStash = base && !blockedWhy(mem, `STASH:${base.id}`, now);
  if (canStash && base.id !== job.id && withinBaseWalk(base, p) && !isCrowded(crowdOfBuilding(mem, base.id))) return true;
  return !(canStash && base.id === job.id) && !!blockedWhy(mem, 'DROP', now);
}

function leaveFull(mem, job) {
  job.leftFull = true;
  mem.haul = { from: job.id, at: job.lastHours };
  setStage(mem, job, 'LEAVE', 'full');
}

// One step along the stages. True when something changed and it is worth looking again.
function advance(mem, job, p, now, threat) {
  const id = here(p);
  const waited = job.spent - job.stageAt;
  if (job.stage === 'IN') {
    if (id === job.id) {
      if (!job.arrived) {
        job.spent = 0;
        job.stageAt = 0;
        arrive(job, p);
      }
      setStage(mem, job, job.backTo || 'SHUT', job.backTo ? 'back inside' : 'inside');
      job.backTo = null;
      return true;
    }
    if (blockedWhy(mem, `ENTER:${job.id}`, now)) {
      endJob(mem, 'no way in');
      return false;
    }
    if (job.spent >= WALK_LIMIT) {
      endJob(mem, 'time');
      return false;
    }
    return false;
  }
  if (job.stage === 'LEAVE') {
    if (id !== job.id) {
      endJob(mem, 'left the house');
      return false;
    }
    const hour = num(p.hour, 12);
    if (isNight(p) || hour >= DUSK_HOUR) {
      endJob(mem, isNight(p) ? 'night' : 'dusk');
      return false;
    }
    if (waited >= LEAVE_MAX) endJob(mem, 'time');
    return false;
  }
  // SHUT, LOOK, SEARCH
  if (id !== job.id) return wentOut(mem, job, p, threat);
  job.left = roomsLeftOf(p) ?? job.left;
  if (!job.rooms) job.rooms = num(p.inBldg.rooms);
  if (job.spent >= jobLimit(job.rooms)) {
    setStage(mem, job, 'LEAVE', 'time');
    return true;
  }
  if (job.stage === 'SHUT') {
    if (securedThisVisit(mem, job.id)) {
      setStage(mem, job, 'LOOK', 'shut');
      return true;
    }
    if (blockedWhy(mem, `SECURE:${job.id}`, now)) {
      setStage(mem, job, 'LOOK', 'could not shut it');
      return true;
    }
    return false;
  }
  if (job.stage === 'LOOK') {
    if (standingInHouse(p) > 0) {
      if (canClear(mem, job, p, now)) {
        toClear(mem, job, p);
        return true;
      }
      if (waited < LOOK_MAX) return false;
      setStage(mem, job, 'LEAVE', 'zombie inside');
      return true;
    }
    if (waited < LOOK_MIN) return false;
    setStage(mem, job, 'SEARCH', 'quiet');
    return true;
  }
  if (job.stage === 'CLEAR') {
    const r = p.res;
    if (r && r.verb === 'CLEAR' && num(r.seq) > num(job.clearSeq)) {
      if (r.status === 'done') {
        setStage(mem, job, 'LOOK', 'cleared');
        return true;
      }
      if (r.status === 'failed') {
        setStage(mem, job, 'LEAVE', `clear failed: ${r.why || 'unknown'}`);
        return true;
      }
      return false;
    }
    // Not sent yet, or another order took its place. Things may have changed since the gate said yes.
    const no = clearBlock(p);
    if (no === 'nobody inside') {
      setStage(mem, job, 'LOOK', 'zombie gone');
      return true;
    }
    if (no || waited >= CLEAR_MAX) {
      setStage(mem, job, 'LEAVE', `clear called off: ${no || 'time'}`);
      return true;
    }
    return false;
  }
  // SEARCH
  const b = building(mem, job.id);
  if ((b && b.searched) || job.left === 0) {
    setStage(mem, job, 'LEAVE', 'searched');
    return true;
  }
  const failed = mem.fails && mem.fails[`SEARCH:${job.id}`];
  const base = baseBuilding(mem);
  const stashHere = base && base.id === job.id && !blockedWhy(mem, `STASH:${base.id}`, now);
  if ((failed && failed.why === 'full' && !stashHere) || (heavy(p) && fullHere(mem, job, p, now))) {
    leaveFull(mem, job);
    return true;
  }
  // A zombie in the house holds SEARCH (senses.mjs, reaches), so the stall clock would run out on it.
  if (!running(p) && zombies(p).some((z) => z.inside) && canClear(mem, job, p, now)) {
    toClear(mem, job, p);
    return true;
  }
  if (job.stall >= STALL_MAX) {
    setStage(mem, job, 'LEAVE', 'blocked');
    return true;
  }
  return false;
}

// She is out of the house with the job not done. A SEARCH or SECURE still running is on its way
// back in (it stops on the first square outside). Driven out by a threat, the job is over. A walk
// that drifted out with nothing after her goes back in, a couple of times at most.
function wentOut(mem, job, p, threat) {
  const busy = running(p);
  if (busy && (busy.verb === 'SEARCH' || busy.verb === 'SECURE')) return false;
  if (threat || job.paused) {
    endJob(mem, 'threat');
    return false;
  }
  if (job.reentries >= MAX_REENTRIES) {
    endJob(mem, 'walked out');
    return false;
  }
  job.reentries += 1;
  // LOOK reads who is in the house again. A CLEAR picked up where it stopped would not.
  job.backTo = job.stage === 'CLEAR' ? 'LOOK' : job.stage;
  setStage(mem, job, 'IN', 'walked out');
  return false;
}

// True when SEARCH cannot be sent right now and nothing is running: what the stall clock counts.
function searchHeld(mem, job, p, now) {
  if (running(p)) return false;
  return heavy(p) || zombies(p).some((z) => reaches(z, SEARCH_R)) || !!blockedWhy(mem, `SEARCH:${job.id}`, now);
}

// Moves the job along for this percept. Called from updateMemory after the result is read. entered:
// she just came into this building. wasVisited: she had been in it before. Calling it twice on one
// percept changes nothing, as with the rest of map memory.
export function stepHouseJob(mem, p, now, { entered = false, wasVisited = false } = {}) {
  if (!p || p.dead) return;
  const hours = num(p.hoursAlive);
  const id = here(p);
  if (mem.job && hours < num(mem.job.lastHours) - 0.5) dropJob(mem, 'new character');
  // Into another house with a job open: the old one is over and this one starts below.
  if (mem.job && mem.job.stage !== 'IN' && id && id !== mem.job.id) endJob(mem, 'another house');
  if (!mem.job && id && entered) {
    const b = building(mem, id);
    if (!(b && b.searched) && roomsLeftOf(p) !== 0) begin(mem, id, 'SHUT', p, wasVisited);
  }
  const job = mem.job;
  if (!job) return;
  const gap = hours - num(job.lastHours);
  const asleep = p.asleep === true;
  if (gap > 0 && gap <= MAX_GAP && !asleep) {
    job.spent += gap;
    if (job.stage === 'SEARCH' && searchHeld(mem, job, p, now)) job.stall += gap;
    else if (job.stage === 'SEARCH' && !running(p)) job.stall = 0;
  }
  job.lastHours = hours;
  const threat = jobThreat(p);
  if (id === job.id || job.stage === 'IN') {
    if (threat && !job.paused) event(mem, { kind: 'pause', bldg: job.id, stage: job.stage, why: threat, hours });
    if (!threat && job.paused) event(mem, { kind: 'resume', bldg: job.id, stage: job.stage, why: job.paused, hours });
    job.paused = threat;
  }
  if (threat && id === job.id) {
    // The stage waits for the threat to pass. But with a pack in the house there is no search left
    // to wait for: when it passes, she goes.
    if (job.stage !== 'LEAVE' && job.stage !== 'IN' && standingInHouse(p) >= PACK_N) setStage(mem, job, 'LEAVE', 'zombies inside');
    return;
  }
  for (let i = 0; i < STAGES.length + 1 && mem.job === job; i++) {
    if (!advance(mem, job, p, now, threat)) break;
  }
}

// An order went out. An ENTER opens a job on that house and ends any other one. A walk away in the
// IN stage means she changed her mind about the house. A house already searched gets no job: she
// is only going home.
export function noteJobOrder(mem, option, p) {
  const job = openJob(mem);
  if (option.verb === 'ENTER' && option.target) {
    const target = String(option.target);
    if (job && job.id === target) return;
    if (job) endJob(mem, job.stage === 'LEAVE' ? 'next house' : 'another house');
    const b = building(mem, target);
    if (!(b && b.searched)) begin(mem, target, 'IN', p, !!(b && b.visited));
  } else if (option.verb === 'GOTO' && job && job.stage === 'IN') {
    endJob(mem, 'walked off');
  }
}

// A house she has no more business in: searched, or given up on lately. hours is the game clock.
export function doneWith(b, hours) {
  if (!b) return false;
  if (b.searched) return true;
  return b.leftAt != null && hours >= b.leftAt && hours - b.leftAt < REVISIT_HOURS;
}

export function crowded(b) {
  return !!b && num(b.zombies) >= CROWD_ZOMBIES;
}

// The door to leave by: the one she came in by, or the nearest other door the map knows, as long as
// the walk keeps clear (clear is pathClear from options.mjs). Null when she is at it or none is safe.
export function leaveExit(p, mem, job, clear) {
  const b = building(mem, job.id);
  const x = num(p.x);
  const y = num(p.y);
  const doors = [];
  if (job.entry && job.entry.how === 'door') doors.push({ x: job.entry.x, y: job.entry.y, came: true });
  if (b && b.door && Number.isFinite(b.door.x) && Number.isFinite(b.door.y)) doors.push({ x: b.door.x, y: b.door.y, came: false });
  const safe = doors.map((d) => ({ ...d, d: dist(d.x - x, d.y - y, 0, 0) })).filter((d) => clear(d.x - x, d.y - y));
  if (!safe.length) return null;
  safe.sort((a, c) => Number(c.came) - Number(a.came) || a.d - c.d);
  return safe[0].d <= AT_EXIT_R ? null : safe[0];
}

export function leaveOption(p, mem, job, clear, now) {
  if (job.stage !== 'LEAVE' || here(p) !== job.id) return null;
  const key = `LEAVE:${job.id}`;
  if (blockedWhy(mem, key, now)) return null;
  const door = leaveExit(p, mem, job, clear);
  if (!door) return null;
  const tx = door.x - num(p.x);
  const ty = door.y - num(p.y);
  return {
    prio: 1.5, id: 'leave', verb: 'GOTO', a: door.x, b: door.y, target: '', key,
    label: `walk ${tiles(door.d)} ${compass(tx, ty)} to the ${door.came ? 'door you came in by' : 'nearest door'}, this house is done`,
  };
}

export function clearOption(p, mem, job, now) {
  if (job.stage !== 'CLEAR' || here(p) !== job.id) return null;
  const key = `CLEAR:${job.id}`;
  if (blockedWhy(mem, key, now)) return null;
  return { prio: 1.5, id: 'clear', verb: 'CLEAR', a: 0, b: 0, target: '', key, label: 'kill the zombie in this house, it has not noticed you' };
}

// The menu with what the job rules out taken off. Only called with nothing threatening her.
export function jobMenu(options, job, p) {
  const enter = (o) => o.verb === 'ENTER';
  const walk = (o) => o.verb === 'GOTO';
  if (job.stage === 'IN') {
    // With the job's own house off the menu (a zombie by the door, say) she needs the others.
    if (!options.some((o) => enter(o) && o.target === job.id) && !(running(p) && running(p).verb === 'ENTER')) return options;
    return options.filter((o) => !(enter(o) && o.target !== job.id) && o.id !== 'explore' && o.id !== 'home');
  }
  if (job.stage === 'LEAVE') {
    return options.filter((o) => (enter(o) ? o.target !== job.id : o.id !== 'home' && o.id !== 'away'));
  }
  return options.filter((o) => !enter(o) && !walk(o));
}

// The nearest house not searched, with few zombies seen. A shop or other building only when no house
// will do, and a crowded place not at all: then she explores. The menu is already nearest first.
export function nextHouse(options, mem, job, hours) {
  const fits = options.filter((o) => {
    if (o.verb !== 'ENTER' || o.target === job.id) return false;
    const b = building(mem, o.target);
    // The crowd map covers houses she never stood in, and fades. Its area is avoided too.
    const cr = crowdOfBuilding(mem, o.target);
    return !doneWith(b, hours) && !crowded(b) && !isCrowded(cr) && !areaCrowded(cr);
  });
  return fits.find((o) => /walk into house/.test(o.label)) || fits[0] || null;
}

// Worth doing on the way, before the next stage. She is inside with nothing on her, so now is when.
const ON_THE_WAY = ['bandage', 'drink', 'eat', 'wearbag'];
const BEFORE_LEAVING = ['fill', 'rest'];

// The policy's order for this stage: [option, thought], or null to leave the turn to the other rules
// and the model.
export function jobPick(p, mem, opts) {
  const job = openJob(mem);
  if (running(p) || jobThreat(p)) return null;
  const by = (id) => opts.find((o) => o.id === id);
  // The load run. The two options only exist when she is too full to search and has a base. It is
  // here and not a rule of its own so it comes ahead of the overloaded rule's drop.
  const load = by('stash') || by('haul');
  if (!job) return load ? [load, load.id === 'stash' ? 'Home, and too full. Putting the spare gear away.' : 'Too full to search. Taking the load home.'] : null;
  if (job.stage === 'IN') {
    const way = opts.find((o) => o.verb === 'ENTER' && o.target === job.id);
    return way ? [way, job.reentries ? 'I walked out of there with rooms left. Going back in.' : 'Going into this house.'] : null;
  }
  // Before the small things: a walk to the tap with it loose in the house is the riskier order.
  if (job.stage === 'CLEAR') return by('clear') ? [by('clear'), 'One in here and it has not seen me. Taking it down.'] : null;
  const side = ON_THE_WAY.map(by).find(Boolean);
  if (side) return [side, 'Quick, while it is quiet in here.'];
  if (job.stage === 'SHUT') return [by('secure'), 'Shutting this house up before I look around.'];
  if (job.stage === 'LOOK') return [by('wait'), 'Listening for anything moving in here.'];
  if (job.stage === 'SEARCH') {
    if (by('search')) return [by('search'), 'Searching this house, room by room.'];
    // Too heavy, and this is the base. With no base the overloaded rule comes next and sends the
    // drop. Either way the search goes on after.
    return by('stash') ? [by('stash'), 'Too full to go on. Putting the spare gear away here.'] : null;
  }
  const last = BEFORE_LEAVING.map(by).find(Boolean);
  if (last) return [last, 'One more thing before I head out.'];
  if (load) return [load, 'My arms are full. Taking this home, then coming back.'];
  if (by('leave')) return [by('leave'), 'This house is done. Heading for the door.'];
  const next = nextHouse(opts, mem, job, num(p.hoursAlive));
  if (next) return [next, 'On to the next house.'];
  if (by('explore')) return [by('explore'), 'Nothing new close by. Going to look for more houses.'];
  return null;
}

// One line for the prompt, so a model that is asked in the middle of a job knows there is one.
export function jobLine(mem, p) {
  const job = openJob(mem);
  if (!job) return '';
  const left = roomsLeftOf(p);
  const rooms = left !== null ? `, ${count(left, 'room')} left` : '';
  const what = { IN: 'getting into a house', SHUT: 'shutting this house', LOOK: 'listening in this house', CLEAR: 'killing the zombie in this house', SEARCH: 'searching this house', LEAVE: 'leaving this house' }[job.stage];
  return `HOUSE JOB: ${what}${rooms}. Finish it before going anywhere else.`;
}
