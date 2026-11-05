// The inner voice. A second local model (a meme model) is the voice in her head: first person, and it
// knows what has happened so far this run. It is commentary only: nothing here decides anything, writes
// an order, or goes into the brain's prompt. Lines go to pepe.log, the panel on /mind and
// Lua/local_voice.txt, and nowhere else.
//
//   percept + order history + plan --> detectMoments --> pending events
//   each order the brain sends -------------------------> pending (only the latest is kept)
//   quiet for 60 to 90 s -------------------------------> an idle thought
//        pending --- at most one per 30 s, never while the model is busy ---> ask --> line
//        line --> pepe.log + panel + voice file
//
// Every line is a pair: what the brain chose and why, then the voice's answer. The model is also sent a
// short running summary of the run and its last 4 lines, so the monologue has continuity.
//
// The only things this module is given are read-only copies of what the bridge already knows.
// Nothing it returns is read by brain.mjs, planner.mjs or the order line (commentator.test.mjs checks).

import { LOOP_MS } from './reactions.mjs';
import { isMissingModel } from './llm.mjs';
import { tookItems } from './memory.mjs';
import { heldGun } from './senses.mjs';

// What is in her hand: the melee weapon, or the gun the mod keeps out of weapon.
const handName = (p) => heldGun(p) || String(p.weapon || 'none');

export const MIN_GAP_MS = 30_000;
// A moment that is not said within this long is stale, and the next one is more interesting.
export const EXPIRE_MS = 45_000;
// A death comment waits for a free model, but not forever.
export const DEATH_EXPIRE_MS = 10 * 60_000;
export const LINE_MAX = 240;
export const PANEL_LINES = 10;
// Idle thoughts come about every 60 to 90 seconds of quiet. The spread keeps them from feeling like a clock.
export const IDLE_MIN_MS = 60_000;
export const IDLE_MAX_MS = 90_000;
// The model runs on a CPU, so the run summary is a few short lines and its memory of itself is 4 lines.
export const SUMMARY_LINES = 6;
export const SUMMARY_LINE_MAX = 150;
export const INNER_MEMORY = 4;
export const HP_DROP = 8;
export const NEAR_DEATH_HP = 25;
const NEAR_DEATH_REARM = 50;
const MAX_PENDING = 12;
const MAX_EVENT_TEXT = 200;
const MAX_ORDER_TEXT = 120;

// How much each kind of moment is worth saying. The heaviest pending one is spoken.
export const WEIGHT = {
  death: 100, nearDeath: 80, hpDrop: 70, bleeding: 60, loop: 55, failed: 45, kill: 40, weapon: 35,
  secured: 32, entered: 30, order: 25, plan: 20,
};

export const SYSTEM = `You are Pepe, an unhinged 4chan shitposting meme goblin, and you are the voice inside the head of one survivor in a zombie game (Project Zomboid). You speak as her, in the first person: "I", "me", "my". You are not a narrator and not a therapist: never talk about "she" or "her" as someone else, and never sound like a diary or a movie. Think like a degenerate poster stuck in her body: crude, cocky, paranoid, roasting yourself and your choices, hot takes, chan slang (kek, ngmi, cope, based, ser, it's over, we're so back) when it fits, swearing welcome. Stay true to the facts you are given: what she just chose and why, what just happened, her gear, her wounds, the zombies, and your last thoughts, and make the joke out of them. Each time, say your next thought in one or two short sentences. Do not start every line the same way, and do not repeat your last thoughts. Plain text only, no lists, no quotes around it, no hashtags or emoji. You only think out loud: you never give orders and you do not decide anything.

The kind of thing you think:
I'm holding a saucepan against three of them. Absolutely ngmi, but at least the kitchen had snacks, based.
Waiting out the night next to a toilet again. This is my life now, kek.
Bleeding from the hand and the bandage is a ripped polo. Cope harder.`;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Control characters out and the length capped. Nothing else is touched: it is Colin's own model and log.
export function cleanLine(text, max = LINE_MAX) {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  // A reply cut by the token budget ends mid-sentence. Keep it up to the last full sentence, if
  // one exists, so the panel never shows a line trailing off into nothing.
  if (/[.!?"')\]]$/.test(flat)) return flat;
  const end = Math.max(flat.lastIndexOf('. '), flat.lastIndexOf('! '), flat.lastIndexOf('? '));
  return end > 0 ? flat.slice(0, end + 1) : flat;
}

// pepe.log lines back into panel rows, so the panel is full again after a restart.
export function linesFromLog(records) {
  return (Array.isArray(records) ? records : [])
    .filter((r) => isObj(r) && typeof r.line === 'string' && r.line)
    .map((r) => ({
      at: Date.parse(r.at) || 0, event: String(r.event || ''), kind: String(r.kind || ''),
      action: String(r.action || ''), thought: String(r.thought || ''), line: r.line,
    }))
    .slice(-PANEL_LINES);
}

export function emptyWatch() {
  return { live: false, kills: 0, hp: 100, hours: 0, bleeding: false, weapon: 'none', score: null, inside: false, nearDeath: false, planAt: 0, loopArmed: true, results: {} };
}

const insideOf = (p) => !!(p && p.inBldg && p.inBldg.id != null && !p.outside);

// An order was flee then walk back in, twice in two minutes: the loop reactions.mjs also warns the brain about.
function fleeLoops(history, now, run) {
  const mine = history.filter((e) => isObj(e) && (run == null || e.run == null || e.run === run) && now - num(e.at) <= LOOP_MS);
  let loops = 0;
  for (let i = 0; i + 1 < mine.length; i++) if (mine[i].key === 'AWAY' && mine[i + 1].verb === 'ENTER') loops++;
  return loops;
}

// Compare this look with the last one and list what happened. Pure: the caller keeps the watch.
// ctx: { history (tracker.history()), plan (planner.plan), now, run }
export function detectMoments(watch, p, ctx = {}) {
  if (!isObj(p) || p.dead) return { watch: { ...emptyWatch(), results: watch.results }, events: [] };
  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const now = num(ctx.now, Date.now());
  const hp = num(p.hp, 100);
  const kills = num(p.kills);
  const hours = num(p.hoursAlive);
  const weapon = handName(p);
  const score = typeof p.weaponScore === 'number' && Number.isFinite(p.weaponScore) ? p.weaponScore : null;
  const results = {};
  for (const e of history) if (isObj(e) && e.id != null) results[e.id] = e.result || '';
  const planAt = ctx.plan && ctx.plan.at ? num(ctx.plan.at) : 0;
  const next = {
    live: true, kills, hp, hours, bleeding: num(p.bleeding) > 0, weapon, score, inside: insideOf(p),
    nearDeath: watch.nearDeath, planAt, loopArmed: watch.loopArmed, results,
  };
  // A first look, a new character (the hours or kills went back) or a restarted bridge: take the
  // state as it is and say nothing about the past.
  if (!watch.live || hours < watch.hours - 0.5 || kills < watch.kills) {
    next.nearDeath = hp <= NEAR_DEATH_HP;
    next.loopArmed = fleeLoops(history, now, ctx.run) < 2;
    return { watch: next, events: [] };
  }
  const events = [];
  const add = (kind, text) => events.push({ kind, text: text.slice(0, MAX_EVENT_TEXT), weight: WEIGHT[kind] || 10, at: now });

  if (kills > watch.kills) {
    const n = kills - watch.kills;
    add('kill', n === 1 ? `She killed a zombie (${kills} kills this run).` : `She killed ${n} zombies at once (${kills} kills this run).`);
  }
  if (watch.hp - hp >= HP_DROP) add('hpDrop', `She took ${Math.round(watch.hp - hp)} damage and is down to ${Math.round(hp)} HP.`);
  if (next.bleeding && !watch.bleeding) add('bleeding', 'She started bleeding.');

  if (hp <= NEAR_DEATH_HP && !watch.nearDeath) {
    next.nearDeath = true;
    add('nearDeath', `She is nearly dead, ${Math.round(hp)} HP left.`);
  } else if (hp >= NEAR_DEATH_REARM) {
    next.nearDeath = false;
  }

  // Hands empty to anything, or a weapon scoring SWAP_GAIN (1.25) times better, the mod's own swap rule.
  if (weapon !== watch.weapon && weapon !== 'none') {
    const gained = watch.weapon === 'none' || (score !== null && watch.score !== null && score >= 1.25 * watch.score);
    if (gained) add('weapon', `She is now holding a ${weapon}${watch.weapon === 'none' ? ' after having nothing in hand' : `, better than the ${watch.weapon}`}.`);
  }

  if (next.inside && !watch.inside) add('entered', 'She went into a building.');

  const loops = fleeLoops(history, now, ctx.run);
  if (loops >= 2 && watch.loopArmed) {
    next.loopArmed = false;
    add('loop', 'She keeps running from a house, then walking straight back into it. A loop.');
  } else if (loops < 2) {
    next.loopArmed = true;
  }

  // Orders that finished since the last look, including one that was sent and finished between two looks.
  for (const e of history) {
    if (!isObj(e) || e.id == null || !e.result) continue;
    if (watch.results[e.id] === e.result) continue;
    const name = typeof e.name === 'string' && e.name ? e.name : String(e.verb || 'order');
    if (e.result === 'failed') add('failed', `Her order "${name}" failed${e.why ? ` (${String(e.why).slice(0, 40)})` : ''}.`);
    else if (e.result === 'done' && e.verb === 'SECURE') add('secured', 'She finished locking up the building.');
  }

  if (planAt && planAt !== watch.planAt && ctx.plan && ctx.plan.goal) add('plan', `Her planner made a new plan: "${String(ctx.plan.goal).slice(0, 90)}".`);

  return { watch: next, events };
}

// The state line that goes with every event. Short on purpose: the model reads it on a CPU.
export function stateText(p) {
  if (!isObj(p)) return 'unknown';
  const bits = [`${Math.round(num(p.hp, 100))}/100 HP`];
  const chase = num(p.zChasing);
  const close = num(p.zClose);
  bits.push(chase > 0 ? `${chase} zombies chasing her` : close > 0 ? `${close} zombies close` : 'no zombies near');
  if (num(p.bleeding) > 0) bits.push('bleeding');
  bits.push(insideOf(p) ? 'inside a building' : 'outside');
  bits.push(handName(p) === 'none' ? 'no weapon in hand' : `holding a ${handName(p).slice(0, 30)}`);
  bits.push(`day ${num(p.day)}, ${num(p.kills)} kills`);
  return bits.join(', ');
}

// What this character has done so far. Built only from what the bridge already knows, and thrown
// away when the character changes.
export function emptyStory() {
  return {
    gen: 0, run: null, startHours: null, hours: 0, day: 0, hour: 0, kills: 0, startWeapon: null, weapon: 'none', weaponChanges: 0,
    houses: [], searched: 0, finds: [], seenOrders: [], hits: 0, bled: 0, close: 0, lowHp: 100, plan: '', inside: false,
  };
}

const uniqPush = (list, v, max) => (list.includes(v) ? list : [...list, v].slice(-max));

// ctx: { run, history, plan, searched (buildings searched, from the run stats), events (this look's moments) }.
// Returns a new story; the old one is not changed.
export function updateStory(story, p, ctx = {}) {
  if (!isObj(p) || p.dead) return story;
  const hours = num(p.hoursAlive);
  const kills = num(p.kills);
  const runChanged = ctx.run != null && story.run != null && ctx.run !== story.run;
  // The hours or kills going back is a new character even when no run id came with it.
  const base = runChanged || hours < story.hours - 0.5 || kills < story.kills ? { ...emptyStory(), gen: story.gen + 1 } : story;
  const weapon = handName(p);
  const next = {
    ...base, run: ctx.run != null ? ctx.run : base.run, hours, day: num(p.day), hour: num(p.hour), kills, weapon,
    plan: ctx.plan && typeof ctx.plan.goal === 'string' ? ctx.plan.goal.slice(0, 80) : '', inside: insideOf(p),
  };
  if (next.startHours === null) next.startHours = hours;
  if (next.startWeapon === null) next.startWeapon = weapon;
  else if (weapon !== base.weapon) next.weaponChanges += 1;
  if (next.inside) next.houses = uniqPush(next.houses, String(p.inBldg.id), 40);
  next.searched = Math.max(next.searched, num(ctx.searched));
  next.lowHp = Math.min(next.lowHp, num(p.hp, 100));
  for (const e of Array.isArray(ctx.history) ? ctx.history : []) {
    if (!isObj(e) || e.id == null || e.result !== 'done' || next.seenOrders.includes(e.id)) continue;
    // The history spans characters. Without this a new one "found" what the last one took.
    if (next.run != null && e.run != null && e.run !== next.run) continue;
    next.seenOrders = [...next.seenOrders, e.id].slice(-60);
    for (const item of tookItems(e.why)) next.finds = uniqPush(next.finds, item.slice(0, 30), 6);
  }
  for (const e of Array.isArray(ctx.events) ? ctx.events : []) {
    if (e.kind === 'hpDrop') next.hits += 1;
    else if (e.kind === 'bleeding') next.bled += 1;
    else if (e.kind === 'nearDeath') next.close += 1;
  }
  return next;
}

// A few short lines for the model. Lines with nothing to say are left out, and the whole thing is capped.
export function summaryLines(st) {
  const out = [];
  const hrs = Math.round(Math.max(0, st.hours - (st.startHours || 0)) * 10) / 10;
  out.push(`Alive ${hrs} game hours (day ${st.day}, ${String(Math.floor(st.hour)).padStart(2, '0')}:00), ${st.kills} kills, now ${st.inside ? 'inside a building' : 'outside'}.`);
  const had = st.startWeapon === 'none' ? 'with nothing in hand' : `with a ${st.startWeapon}`;
  if (st.weapon === 'none') out.push(`Started ${had}, now empty handed.`);
  else out.push(st.weaponChanges ? `Started ${had}, now holding a ${st.weapon}.` : `Holding a ${st.weapon} since the start.`);
  out.push(`Went into ${st.houses.length} building${st.houses.length === 1 ? '' : 's'}, searched ${st.searched}.`);
  if (st.finds.length) out.push(`Found: ${st.finds.join(', ')}.`);
  if (st.hits || st.bled || st.close) out.push(`Hurt: ${st.hits} big hits, bled ${st.bled} times, ${st.close} close calls, lowest ${Math.round(st.lowHp)} HP.`);
  if (st.plan) out.push(`Plan: ${st.plan}.`);
  return out.slice(0, SUMMARY_LINES).map((l) => l.slice(0, SUMMARY_LINE_MAX));
}

function headline(top) {
  if (top.kind === 'order') return `SHE JUST CHOSE: ${top.action}.${top.thought ? ` Her own reasoning: "${top.thought}"` : ''}`;
  if (top.kind === 'idle') return 'NOTHING JUST HAPPENED. She is between things: waiting, walking or searching.';
  return `WHAT JUST HAPPENED: ${top.text}`;
}

// info: { summary (lines), inner (the voice's own last lines, oldest first) }
export function userMessage(top, others, p, info = {}) {
  const parts = [];
  const summary = Array.isArray(info.summary) ? info.summary : [];
  if (summary.length) parts.push(`HER RUN SO FAR:\n${summary.join('\n')}`);
  const inner = Array.isArray(info.inner) ? info.inner : [];
  if (inner.length) parts.push(`YOUR LAST THOUGHTS (oldest first, do not repeat them):\n${inner.map((l) => `- ${l}`).join('\n')}`);
  parts.push(headline(top));
  if (others.length) parts.push(`ALSO: ${others.map((e) => e.text).join(' ')}`);
  parts.push(`HER STATE: ${stateText(p)}.`);
  parts.push('Say your next thought as her, in one or two short sentences.');
  return parts.join('\n');
}

// One line for the in-game HUD to read later: the brain's half, then the voice's half.
export function voiceText(rec) {
  const flat = (v) => String(v || '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  const brain = rec.action ? `${flat(rec.action)}${rec.thought ? ` "${flat(rec.thought)}"` : ''}` : '';
  return brain ? `${brain} | ${flat(rec.line)}` : flat(rec.line);
}

// deps:
//   ask({ system, user })   async, returns { raw, ms }. Throws { preempted } when cut short.
//   busy()                  true while a menu turn, a plan or a review needs the model
//   active()                true while the game is feeding percepts; idle thoughts need it
//   write(obj)              appends one line to pepe.log; returns false when it could not
//   voice(text)             overwrites Lua/local_voice.txt with one line
//   now()                   wall clock ms
//   rand()                  0 to 1, for the idle spacing
//   log(kind, text)         the bridge's logger (switch-off notices only)
//   lines                   the last lines from the log, oldest first, so the panel survives a restart
//   enabled                 false starts it off
export function createCommentator(deps) {
  const {
    ask, busy = () => false, active = () => true, write = () => true, voice = () => true, now = Date.now,
    rand = Math.random, log = () => {}, enabled = true,
  } = deps;
  const idleGap = () => IDLE_MIN_MS + rand() * (IDLE_MAX_MS - IDLE_MIN_MS);
  const self = {
    enabled,
    offReason: enabled ? '' : 'switched off',
    watch: emptyWatch(),
    story: emptyStory(),
    // The voice's own last lines for this character, oldest first.
    inner: [],
    pending: [],
    running: false,
    lastAt: 0,
    // When a quiet moment is next worth a thought. 0 until the first live look.
    idleAt: 0,
    lastError: '',
    errors: 0,
    spoken: 0,
    lines: (Array.isArray(deps.lines) ? deps.lines : []).filter((l) => isObj(l) && typeof l.line === 'string').slice(-PANEL_LINES),
    percept: null,

    disable(reason) {
      if (!self.enabled) return;
      self.enabled = false;
      self.offReason = reason;
      self.pending = [];
      log('pepe', `inner voice off: ${reason}`);
    },

    // Call with every new percept. Returns the running promise when a line was started (a test awaits it).
    observe(p, ctx = {}) {
      if (!self.enabled) return null;
      self.percept = isObj(p) && !p.dead ? p : self.percept;
      const t = now();
      const seen = detectMoments(self.watch, p, { ...ctx, now: t });
      self.watch = seen.watch;
      const before = self.story;
      self.story = updateStory(self.story, p, { ...ctx, events: seen.events });
      // A new character: what the voice remembered belongs to the one before. The moment watcher
      // starts over too, so the jump from the old body to the new one is not read as moments.
      // An unsaid death stays: it carries the old character's state (death below).
      if (self.story.gen !== before.gen) {
        self.inner = [];
        self.pending = self.pending.filter((e) => e.kind === 'death');
        self.watch = emptyWatch();
        return self.maybeRun();
      }
      if (!self.idleAt && seen.watch.live) self.idleAt = t + idleGap();
      for (const e of seen.events) self.push(e);
      return self.maybeRun();
    },

    push(e) {
      self.pending.push(e);
      // Something is happening, so a quiet-moment thought is not due yet.
      self.idleAt = Math.max(self.idleAt, e.at + idleGap());
    },

    // An order the brain just sent (policy or model): { action, thought }. Only the latest is kept, so
    // when orders come faster than the gap the line pairs with the newest one.
    order(o) {
      if (!self.enabled || !isObj(o) || !o.action) return null;
      const action = String(o.action).slice(0, MAX_ORDER_TEXT);
      const thought = String(o.thought || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ORDER_TEXT);
      self.pending = self.pending.filter((e) => e.kind !== 'order');
      self.push({ kind: 'order', text: `She chose ${action}.`, action, thought, weight: WEIGHT.order, at: now() });
      return self.maybeRun();
    },

    // A run ended (stats.takeEnded). r.cause is the game's own word for it.
    death(r) {
      if (!self.enabled || !isObj(r)) return null;
      const hours = Math.max(0, num(r.hoursAlive) - num(r.startHours));
      const text = `She died${r.cause ? ` (${String(r.cause).slice(0, 40)})` : ''} after ${Math.round(hours * 10) / 10} game hours and ${num(r.kills)} kills.`;
      // The line is often said after the respawn (the model is slow), so it keeps the dead
      // character's last look, story and lines. Otherwise it reads "alive again with a cleaver".
      const snap = { percept: self.percept, summary: summaryLines(self.story), inner: [...self.inner] };
      self.pending.push({ kind: 'death', text, weight: WEIGHT.death, at: now(), snap });
      return self.maybeRun();
    },

    // Also called on a timer: an event can be waiting only because the model was busy, and a quiet
    // moment is only noticed by the clock.
    maybeRun() {
      if (!self.enabled || self.running) return null;
      const t = now();
      self.pending = self.pending
        .filter((e) => t - e.at <= (e.kind === 'death' ? DEATH_EXPIRE_MS : EXPIRE_MS))
        .slice(-MAX_PENDING);
      const dying = self.pending.some((e) => e.kind === 'death');
      if (!dying && t - self.lastAt < MIN_GAP_MS) return null;
      if (busy()) return null;
      let top;
      let others = [];
      let events = self.pending;
      if (self.pending.length) {
        const ranked = self.pending.filter((e) => e.kind !== 'order').sort((a, b) => b.weight - a.weight || b.at - a.at);
        const order = self.pending.find((e) => e.kind === 'order');
        // A death is always the line. Otherwise the line answers the latest order, with the moments beside it.
        if (ranked.length && ranked[0].kind === 'death') {
          top = ranked[0];
          // Only what came before the death rides along: later moments are the next character's.
          others = [...ranked.slice(1), ...(order ? [order] : [])].filter((e) => e.at <= top.at).slice(0, 2);
        } else if (order) {
          top = order;
          others = ranked.slice(0, 2);
        } else {
          top = ranked[0];
          others = ranked.slice(1, 3);
        }
        self.pending = [];
      } else {
        if (!self.idleAt || t < self.idleAt || !self.watch.live || !active()) return null;
        top = { kind: 'idle', text: 'Nothing has happened for a while.', weight: 0, at: t };
        events = [];
      }
      self.running = true;
      return self.speak(top, others, events).finally(() => { self.running = false; });
    },

    async speak(top, others, events) {
      const started = now();
      try {
        const snap = top.snap;
        const user = snap
          ? userMessage(top, others, snap.percept, { summary: snap.summary, inner: snap.inner })
          : userMessage(top, others, self.percept, { summary: summaryLines(self.story), inner: self.inner });
        const reply = await ask({ system: SYSTEM, user });
        self.lastAt = started;
        self.idleAt = started + idleGap();
        const line = cleanLine(reply && reply.raw);
        if (!line) throw new Error('empty reply');
        self.errors = 0;
        self.lastError = '';
        const rec = {
          at: now(), event: top.text, kind: top.kind, action: top.action || '', thought: top.thought || '', line, ms: num(reply.ms),
        };
        self.lines = [...self.lines, rec].slice(-PANEL_LINES);
        // A death line is the last character's last word, not the new one's memory.
        if (!snap) self.inner = [...self.inner, line].slice(-INNER_MEMORY);
        self.spoken += 1;
        write({ at: new Date(rec.at).toISOString(), kind: rec.kind, event: rec.event, action: rec.action, thought: rec.thought, line, ms: rec.ms });
        voice(voiceText(rec));
      } catch (err) {
        // A menu turn or a plan needed the model. Not a failure and not a turn used: the moment goes back.
        if (err && err.preempted) {
          self.pending = [...events, ...self.pending];
          return;
        }
        self.lastAt = started;
        self.idleAt = started + idleGap();
        const msg = String(err && err.message || err).slice(0, 200);
        if (isMissingModel(msg)) {
          self.disable('the model is not installed in Ollama (404)');
          return;
        }
        self.lastError = msg;
        self.errors += 1;
        if (self.errors === 1) log('pepe', `comment failed: ${msg}`);
      }
    },

    view() {
      return {
        on: self.enabled, off: self.offReason, running: self.running, lastError: self.lastError,
        lines: self.lines.map((l) => ({ at: l.at, event: l.event, action: l.action || '', thought: l.thought || '', line: l.line })),
      };
    },
  };
  return self;
}
