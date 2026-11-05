// Lessons written after a death (Reflexion, GUIDE in docs/research.md). The slow planner model
// reads the end of a run and writes up to 3 short rules. Each carries a trigger tag the bridge
// can test, so a tactical turn only reads the lessons that are true right now.
//
// Stored in bridge/lessons.json. The store is plain data and every function here is pure
// except the ones that say they mutate it, so the bridge owns the file and the clock.

import { extractJSON } from './decide.mjs';
import { needs, isNight, inside, heavy, chasing } from './senses.mjs';
import { securedThisVisit } from './memory.mjs';
import { clock } from './words.mjs';

export const MAX_LESSONS = 20;
export const MAX_ACTIVE = 3;
export const MAX_PER_REVIEW = 3;
export const MAX_RUNS = 50;
// A lesson must have been in play this many runs before it can be flagged.
export const FLAG_MIN_RUNS = 3;
const TEXT_MIN = 10;
const TEXT_MAX = 140;
const NEAR_DUPLICATE = 0.7;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// The fixed list. The model may only pick one of these as `when`, so a lesson can never
// depend on something the bridge cannot test. `says` is what the review prompt shows the model.
export const TRIGGERS = {
  night: { says: 'it is night (21:00 to 06:00)', test: (p) => isNight(p) },
  outside: { says: 'standing outdoors', test: (p) => !inside(p) },
  tired: { says: 'tiredness is high', test: (p) => needs(p).has('tired') },
  panicked: { says: 'panic is high', test: (p) => needs(p).has('panicked') },
  wounded: { says: 'has a wound that needs treating', test: (p) => needs(p).has('wounded') },
  bleeding: { says: 'a body part is bleeding', test: (p) => needs(p).has('bleeding') },
  thirsty: { says: 'thirst is high', test: (p) => needs(p).has('thirsty') },
  hungry: { says: 'hunger is high', test: (p) => needs(p).has('hungry') },
  overloaded: { says: 'carrying too much', test: (p) => heavy(p) },
  chased: { says: 'at least 1 zombie is chasing', test: (p) => chasing(p) >= 1 },
  chased2plus: { says: '2 or more zombies are chasing', test: (p) => chasing(p) >= 2 },
  inside_unsecured: {
    says: 'inside a building whose doors and curtains are not shut yet',
    test: (p, mem) => inside(p) && !securedThisVisit(mem, p.inBldg.id),
  },
  no_weapon: {
    says: 'no weapon in hand or carried',
    test: (p) => String(p.weapon || 'none') === 'none' && !(Array.isArray(p.weapons) && p.weapons.length),
  },
  low_endurance: { says: 'endurance is low', test: (p) => needs(p).has('winded') },
};

export const LESSON_TAGS = Object.keys(TRIGGERS);

export function emptyStore() {
  return { version: 1, lessons: [], runs: [] };
}

// An old or hand-edited lessons.json must not crash the bridge. Bad rows are dropped.
export function loadLessons(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;
  for (const l of Array.isArray(raw.lessons) ? raw.lessons : []) {
    if (!l || typeof l !== 'object' || !LESSON_TAGS.includes(l.when)) continue;
    const text = cleanText(l.text);
    if (!text || typeof l.id !== 'string') continue;
    store.lessons.push({ id: l.id, when: l.when, text, created: num(l.created), runs: Math.max(0, Math.floor(num(l.runs))) });
  }
  for (const r of Array.isArray(raw.runs) ? raw.runs : []) {
    if (!r || typeof r !== 'object') continue;
    store.runs.push({
      at: num(r.at), hours: num(r.hours), kills: num(r.kills),
      used: (Array.isArray(r.used) ? r.used : []).filter((x) => typeof x === 'string'),
    });
  }
  store.runs = store.runs.slice(-MAX_RUNS);
  return store;
}

// One line, no pipe (the intent file uses it as a separator), no model-style dashes.
export function cleanText(text) {
  if (typeof text !== 'string') return '';
  const t = text
    .replace(/[\u2014\u2013]/g, ', ')
    .replace(/[|\r\n\t]+/g, ' ')
    .replace(/^\s*lesson\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length < TEXT_MIN ? '' : t.slice(0, TEXT_MAX);
}

const normal = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (t) => new Set(normal(t).split(' ').filter((w) => w.length > 2));

// Exact (ignoring case and punctuation), or the same trigger with most words shared.
export function similar(a, b) {
  if (normal(a.text) === normal(b.text)) return true;
  if (a.when !== b.when) return false;
  const x = words(a.text);
  const y = words(b.text);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared) >= NEAR_DUPLICATE;
}

// Model output into at most 3 valid { when, text } pairs. A lesson with a trigger that is not
// on the list is dropped, not repaired: guessing the nearest tag would write a rule that
// fires at the wrong time.
export function parseLessons(raw) {
  const out = { lessons: [], rejected: [] };
  let data;
  try {
    data = extractJSON(raw);
  } catch (err) {
    out.rejected.push(`not JSON: ${String(err && err.message || err).slice(0, 80)}`);
    return out;
  }
  const rows = data && Array.isArray(data.lessons) ? data.lessons : null;
  if (!rows) {
    out.rejected.push('no lessons array');
    return out;
  }
  for (const row of rows) {
    if (out.lessons.length >= MAX_PER_REVIEW) {
      out.rejected.push('more than 3 lessons');
      break;
    }
    const when = row && typeof row.when === 'string' ? row.when.trim() : '';
    if (!LESSON_TAGS.includes(when)) {
      out.rejected.push(`bad trigger "${String(when).slice(0, 24)}"`);
      continue;
    }
    const text = cleanText(row.text);
    if (!text) {
      out.rejected.push(`empty or short text for ${when}`);
      continue;
    }
    const lesson = { when, text };
    if (out.lessons.some((l) => similar(l, lesson))) {
      out.rejected.push(`duplicate in the same review (${when})`);
      continue;
    }
    out.lessons.push(lesson);
  }
  return out;
}

// Mutates store. Skips anything that matches a stored lesson, then drops the oldest past 20.
export function addLessons(store, items, now) {
  const result = { added: [], duplicates: 0, dropped: [] };
  items.forEach((item, i) => {
    if (store.lessons.some((l) => similar(l, item))) {
      result.duplicates += 1;
      return;
    }
    const lesson = { id: `l${Math.floor(now).toString(36)}${i}`, when: item.when, text: item.text, created: now, runs: 0 };
    store.lessons.push(lesson);
    result.added.push(lesson);
  });
  while (store.lessons.length > MAX_LESSONS) {
    let oldest = 0;
    store.lessons.forEach((l, i) => { if (l.created < store.lessons[oldest].created) oldest = i; });
    result.dropped.push(store.lessons.splice(oldest, 1)[0]);
  }
  return result;
}

// Mutates store. True when something was removed.
export function deleteLesson(store, id) {
  const before = store.lessons.length;
  store.lessons = store.lessons.filter((l) => l.id !== id);
  return store.lessons.length < before;
}

// The lessons whose trigger holds now, at most 3, newest first. A throwing test counts as false.
export function activeLessons(lessons, p, mem, max = MAX_ACTIVE) {
  if (!p || !Array.isArray(lessons)) return [];
  return lessons
    .filter((l) => {
      const t = TRIGGERS[l.when];
      try {
        return !!t && !!t.test(p, mem || {});
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.created - a.created)
    .slice(0, max);
}

// Mutates store. `run.used` are the lesson ids that went into at least one tactical prompt.
export function recordRun(store, run, now) {
  const used = [...new Set(run.used || [])].filter((id) => store.lessons.some((l) => l.id === id));
  store.runs.push({ at: now, hours: num(run.hours), kills: num(run.kills), used });
  store.runs = store.runs.slice(-MAX_RUNS);
  for (const l of store.lessons) if (used.includes(l.id)) l.runs += 1;
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x.hours, 0) / xs.length : null);

// Per lesson: how long runs lasted with it in play against without it. A rough signal for
// Colin, not proof: lessons fire in different situations and the runs are few. `flagged` only
// asks him to look, nothing here deletes.
export function lessonStats(store) {
  return store.lessons.map((l) => {
    const withIt = store.runs.filter((r) => r.used.includes(l.id));
    const without = store.runs.filter((r) => !r.used.includes(l.id));
    const a = avg(withIt);
    const b = avg(without);
    return {
      id: l.id, runsWith: withIt.length, runsWithout: without.length,
      avgWith: a, avgWithout: b,
      flagged: withIt.length >= FLAG_MIN_RUNS && a != null && b != null && a < b,
    };
  });
}

export const REVIEW_SYSTEM = `You review one finished run of a survivor in Project Zomboid and write lessons for the next run. The survivor is steered by a small fast model that reads one short rule list every few seconds. You think slowly, once, after a death.

Write at most 3 lessons. Each is {"when": <trigger>, "text": <one rule>}.
- "when" must be exactly one of the triggers below. A lesson is only shown while its trigger is true.
- "text" is one plain sentence, under 120 characters, written as an order for the fast model: what to do or avoid. Say why only if it fits.
- Base each lesson on what the log shows. Do not invent causes. Do not repeat a lesson already known.
- It is fine to write fewer than 3, or none, if the run shows nothing worth learning.

Triggers:
${LESSON_TAGS.map((t) => `- ${t}: ${TRIGGERS[t].says}`).join('\n')}

Reply with JSON only: {"lessons": [{"when": "...", "text": "..."}]}`;

export function reviewSchema() {
  return {
    type: 'object',
    properties: {
      lessons: {
        type: 'array',
        maxItems: MAX_PER_REVIEW,
        items: {
          type: 'object',
          properties: { when: { type: 'string', enum: [...LESSON_TAGS] }, text: { type: 'string', maxLength: TEXT_MAX } },
          required: ['when', 'text'],
        },
      },
    },
    required: ['lessons'],
  };
}

// log: [{ t, kind, text }] already cut to the last few minutes. digestText: digest() of the
// last live percept. known: the stored lessons, so the model does not write them again.
export function reviewPrompt({ log, run, digestText, final, known }) {
  const parts = [];
  parts.push(`RUN:\nSurvived ${num(run.hours).toFixed(1)} game hours, ${num(run.kills)} kills, died on day ${num(final.day)} at ${clock(final.hour)}.`);
  parts.push(`LAST SITUATION:\n${digestText}`);
  parts.push(`LAST DECISIONS, oldest first:\n${log.length ? log.map((l) => `[${l.t}] ${l.kind}: ${String(l.text).slice(0, 160)}`).join('\n') : '(none logged)'}`);
  if (known.length) parts.push(`LESSONS ALREADY KNOWN (do not repeat):\n${known.map((l) => `- (${l.when}) ${l.text}`).join('\n')}`);
  parts.push('Write the lessons.');
  return parts.join('\n\n');
}

// ask: async ({ system, user, schema }) => { raw }. Returns what parseLessons returns.
export async function reviewDeath(ask, input) {
  const raw = (await ask({ system: REVIEW_SYSTEM, user: reviewPrompt(input), schema: reviewSchema() })).raw;
  return parseLessons(raw);
}
