// Lessons: triggers, parsing, dedupe, the 20 cap, run records and the "worse with it" flag.
// The planner model is mocked everywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture } from './fixtures/load.mjs';
import { recordOrder, updateMemory } from './memory.mjs';
import {
  LESSON_TAGS, TRIGGERS, MAX_LESSONS, MAX_ACTIVE, FLAG_MIN_RUNS,
  emptyStore, loadLessons, parseLessons, similar, addLessons, deleteLesson,
  activeLessons, recordRun, lessonStats, reviewDeath, reviewPrompt, reviewSchema, REVIEW_SYSTEM,
} from './lessons.mjs';

const NOW = 1_000_000;
const fire = (tag, name, patch = {}) => {
  const { percept, memory } = loadFixture(name);
  return TRIGGERS[tag].test({ ...percept, ...patch }, memory);
};

test('the trigger list is the one the card names, and each tag has a test and a sentence', () => {
  assert.deepEqual([...LESSON_TAGS].sort(), [
    'bleeding', 'chased', 'chased2plus', 'hungry', 'inside_unsecured', 'low_endurance', 'night',
    'no_weapon', 'outside', 'overloaded', 'panicked', 'thirsty', 'tired', 'wounded',
  ]);
  for (const t of LESSON_TAGS) {
    assert.equal(typeof TRIGGERS[t].test, 'function', t);
    assert.ok(TRIGGERS[t].says.length > 5, t);
  }
});

test('triggers match the percept', () => {
  assert.equal(fire('night', 'v2-night-outside.json'), true);
  assert.equal(fire('night', 'v2-day-searched-house.json'), false);
  assert.equal(fire('outside', 'v2-night-outside.json'), true);
  assert.equal(fire('outside', 'v2-day-searched-house.json'), false);
  assert.equal(fire('tired', 'v2-night-tired-bed.json'), true);
  assert.equal(fire('tired', 'v2-day-searched-house.json'), false);
  assert.equal(fire('thirsty', 'v2-indoors-thirsty-sink.json'), true);
  assert.equal(fire('thirsty', 'v2-day-searched-house.json'), false);
  assert.equal(fire('hungry', 'v2-day-searched-house.json', { hunger: 0.7 }), true);
  assert.equal(fire('hungry', 'v2-day-searched-house.json'), false);
  assert.equal(fire('bleeding', 'v2-bleeding.json'), true);
  assert.equal(fire('bleeding', 'v2-day-searched-house.json'), false);
  assert.equal(fire('wounded', 'v2-bleeding.json'), true);
  assert.equal(fire('wounded', 'v2-day-searched-house.json'), false);
  assert.equal(fire('panicked', 'v2-day-searched-house.json', { panic01: 0.6 }), true);
  assert.equal(fire('panicked', 'v2-day-searched-house.json'), false);
  assert.equal(fire('overloaded', 'v2-day-searched-house.json', { weight: 8, maxWeight: 8 }), true);
  assert.equal(fire('overloaded', 'v2-day-searched-house.json'), false);
  assert.equal(fire('low_endurance', 'v2-day-searched-house.json', { endurance: 0.2 }), true);
  assert.equal(fire('low_endurance', 'v2-day-searched-house.json'), false);
});

test('chased and chased2plus count the chasers', () => {
  assert.equal(fire('chased', 'v2-outside-chased.json'), true);
  assert.equal(fire('chased2plus', 'v2-outside-chased.json'), true);
  assert.equal(fire('chased', 'v2-night-outside.json'), false);
  const one = { zList: [{ dx: 9, dy: 0, d: 9, chase: true }], zChasing: 1 };
  assert.equal(fire('chased', 'v2-night-outside.json', one), true);
  assert.equal(fire('chased2plus', 'v2-night-outside.json', one), false);
});

test('no_weapon needs nothing in hand and nothing carried', () => {
  assert.equal(fire('no_weapon', 'v2-night-outside.json'), false);
  assert.equal(fire('no_weapon', 'v2-night-outside.json', { weapon: 'none', weapons: [] }), true);
  // A knife in the bag is a weapon she can equip, so the lesson does not fire.
  assert.equal(fire('no_weapon', 'v2-indoors-thirsty-sink.json'), false);
});

test('inside_unsecured turns false once the doors and curtains are shut', () => {
  const { percept, memory } = loadFixture('v2-night-tired-bed.json');
  assert.equal(TRIGGERS.inside_unsecured.test(percept, memory), true);
  assert.equal(TRIGGERS.inside_unsecured.test({ ...percept, inBldg: null, outside: true }, memory), false);
  recordOrder(memory, 53, { verb: 'SECURE', key: 'SECURE:4033' }, percept);
  updateMemory(memory, { ...percept, res: { seq: 53, status: 'done', verb: 'SECURE', why: 'closed 2 doors' }, hoursAlive: percept.hoursAlive + 0.2 }, NOW);
  assert.equal(TRIGGERS.inside_unsecured.test(percept, memory), false);
});

test('parseLessons keeps good lessons and rejects a trigger that is not on the list', () => {
  const raw = JSON.stringify({
    lessons: [
      { when: 'night', text: 'Be inside a shut house before dark.' },
      { when: 'whenever', text: 'Always carry water around with you.' },
      { when: 'Night', text: 'Wrong case does not count as night.' },
      { when: 'bleeding', text: 'Bandage before opening the next door.' },
    ],
  });
  const out = parseLessons(raw);
  assert.deepEqual(out.lessons.map((l) => l.when), ['night', 'bleeding']);
  assert.equal(out.rejected.filter((r) => /bad trigger/.test(r)).length, 2);
});

test('parseLessons takes at most 3 and cleans the text', () => {
  const rows = [
    { when: 'night', text: 'Lesson: Stay in at night | no walks\nin the dark \u2014 ever.' },
    { when: 'tired', text: 'Sleep once a bed is found and doors are shut.' },
    { when: 'thirsty', text: 'Fill bottles at every working tap you pass.' },
    { when: 'hungry', text: 'Eat before hunger gets high, not after.' },
  ];
  const out = parseLessons(`here you go: ${JSON.stringify({ lessons: rows })}`);
  assert.equal(out.lessons.length, 3);
  assert.equal(out.lessons[0].text, 'Stay in at night no walks in the dark , ever.');
  assert.ok(out.rejected.some((r) => /more than 3/.test(r)));
  assert.ok(out.lessons.every((l) => !/[|\n\u2014]/.test(l.text)));
});

test('parseLessons rejects junk, short text, missing fields and repeats in one review', () => {
  assert.equal(parseLessons('no json at all').lessons.length, 0);
  assert.equal(parseLessons('{"nothing": 1}').lessons.length, 0);
  assert.equal(parseLessons('{"lessons": []}').lessons.length, 0);
  const out = parseLessons(JSON.stringify({
    lessons: [
      { when: 'night', text: 'short' },
      { when: 'night' },
      null,
      { when: 'outside', text: 'x'.repeat(400) },
      { when: 'outside', text: 'x'.repeat(400) },
    ],
  }));
  assert.equal(out.lessons.length, 1);
  assert.equal(out.lessons[0].text.length, 140);
  assert.equal(out.rejected.length, 4);
});

test('similar: exact ignoring case and punctuation, or the same trigger with most words shared', () => {
  const a = { when: 'night', text: 'Stay inside a shut house at night.' };
  assert.ok(similar(a, { when: 'tired', text: 'stay INSIDE a shut house, at night' }));
  assert.ok(similar(a, { when: 'night', text: 'Stay inside a shut house at night always.' }));
  assert.equal(similar(a, { when: 'tired', text: 'Stay inside a shut house at night always.' }), false);
  assert.equal(similar(a, { when: 'night', text: 'Fill bottles at every working tap.' }), false);
});

test('addLessons drops exact and near duplicates against the store', () => {
  const store = emptyStore();
  const first = addLessons(store, [{ when: 'night', text: 'Stay inside a shut house at night.' }], NOW);
  assert.equal(first.added.length, 1);
  assert.equal(first.added[0].runs, 0);
  const second = addLessons(store, [
    { when: 'night', text: 'stay inside a shut house at night' },
    { when: 'night', text: 'Stay inside a shut house at night always.' },
    { when: 'thirsty', text: 'Fill bottles at every working tap.' },
  ], NOW + 1);
  assert.equal(second.added.length, 1);
  assert.equal(second.duplicates, 2);
  assert.equal(store.lessons.length, 2);
  assert.equal(new Set(store.lessons.map((l) => l.id)).size, 2, 'ids are unique');
});

test('at most 20 lessons: the oldest goes first', () => {
  const store = emptyStore();
  const topics = ['water', 'bandages', 'doors', 'axes', 'fences', 'cars', 'noise', 'lights', 'fires', 'beds', 'maps', 'books',
    'rain', 'boots', 'bags', 'keys', 'glass', 'sheets', 'bats', 'pots', 'cans', 'nails'];
  topics.forEach((t, i) => addLessons(store, [{ when: 'outside', text: `Think about ${t} before ${t} matter ${i * 7919}.` }], NOW + i));
  assert.equal(store.lessons.length, MAX_LESSONS);
  assert.ok(!store.lessons.some((l) => /about water/.test(l.text)), 'the first one was dropped');
  assert.ok(!store.lessons.some((l) => /about bandages/.test(l.text)), 'the second one was dropped');
  assert.ok(store.lessons.some((l) => /about nails/.test(l.text)));
  // Three at once into a full store drops the three oldest.
  const r = addLessons(store, [
    { when: 'night', text: 'Close curtains before lighting a lamp inside.' },
    { when: 'tired', text: 'Rest in a bed rather than on the floor.' },
    { when: 'hungry', text: 'Open cans only when no zombie is in view.' },
  ], NOW + 100);
  assert.equal(store.lessons.length, MAX_LESSONS);
  assert.equal(r.dropped.length, 3);
});

test('activeLessons: only true triggers, at most 3, newest first', () => {
  const { percept, memory } = loadFixture('v2-night-outside.json');
  const lessons = [
    { id: 'a', when: 'night', text: 'one', created: 1, runs: 0 },
    { id: 'b', when: 'outside', text: 'two', created: 2, runs: 0 },
    { id: 'c', when: 'bleeding', text: 'three', created: 3, runs: 0 },
    { id: 'd', when: 'night', text: 'four', created: 4, runs: 0 },
    { id: 'e', when: 'outside', text: 'five', created: 5, runs: 0 },
    { id: 'f', when: 'nonsense', text: 'six', created: 6, runs: 0 },
  ];
  const got = activeLessons(lessons, percept, memory);
  assert.deepEqual(got.map((l) => l.id), ['e', 'd', 'b']);
  assert.equal(got.length, MAX_ACTIVE);
  assert.deepEqual(activeLessons(lessons, null, memory), []);
  assert.deepEqual(activeLessons(undefined, percept, memory), []);
});

test('loadLessons drops bad rows and keeps good ones', () => {
  assert.deepEqual(loadLessons('junk'), emptyStore());
  const back = loadLessons({
    lessons: [
      { id: 'l1', when: 'night', text: 'Be inside before dark.', created: 5, runs: 2 },
      { id: 'l2', when: 'bogus', text: 'Not a trigger at all.', created: 5, runs: 0 },
      { when: 'night', text: 'No id on this one at all.', created: 5 },
      { id: 'l3', when: 'night', text: 'tiny', created: 5 },
    ],
    runs: [{ at: 1, hours: 4, kills: 2, used: ['l1', 7] }, 'junk'],
  });
  assert.deepEqual(back.lessons.map((l) => l.id), ['l1']);
  assert.deepEqual(back.runs, [{ at: 1, hours: 4, kills: 2, used: ['l1'] }]);
});

test('deleteLesson removes one by id', () => {
  const store = emptyStore();
  const { added } = addLessons(store, [{ when: 'night', text: 'Be inside before dark.' }], NOW);
  assert.equal(deleteLesson(store, 'nope'), false);
  assert.equal(deleteLesson(store, added[0].id), true);
  assert.equal(store.lessons.length, 0);
});

test('recordRun counts the runs a lesson was active in', () => {
  const store = emptyStore();
  const { added } = addLessons(store, [{ when: 'night', text: 'Be inside before dark.' }], NOW);
  const id = added[0].id;
  recordRun(store, { hours: 10, kills: 3, used: [id, id, 'gone'] }, NOW + 1);
  recordRun(store, { hours: 12, kills: 0, used: [] }, NOW + 2);
  assert.equal(store.lessons[0].runs, 1);
  assert.deepEqual(store.runs[0].used, [id], 'repeats and deleted lessons are not kept');
  assert.equal(store.runs.length, 2);
});

test('flag: 3 or more runs with the lesson, and they ended sooner than the runs without it', () => {
  const store = emptyStore();
  const { added } = addLessons(store, [{ when: 'night', text: 'Be inside before dark.' }], NOW);
  const id = added[0].id;
  recordRun(store, { hours: 30, kills: 0, used: [] }, NOW + 1);
  recordRun(store, { hours: 40, kills: 0, used: [] }, NOW + 2);
  recordRun(store, { hours: 10, kills: 0, used: [id] }, NOW + 3);
  recordRun(store, { hours: 12, kills: 0, used: [id] }, NOW + 4);
  let s = lessonStats(store)[0];
  assert.equal(s.flagged, false, 'only 2 runs with it');
  recordRun(store, { hours: 14, kills: 0, used: [id] }, NOW + 5);
  s = lessonStats(store)[0];
  assert.equal(s.runsWith, FLAG_MIN_RUNS);
  assert.equal(s.avgWith, 12);
  assert.equal(s.avgWithout, 35);
  assert.equal(s.flagged, true);
  assert.equal(store.lessons.length, 1, 'flagging never deletes');
});

test('no flag when the runs with it lasted longer, or there is nothing to compare against', () => {
  const store = emptyStore();
  const { added } = addLessons(store, [{ when: 'night', text: 'Be inside before dark.' }], NOW);
  const id = added[0].id;
  for (let i = 0; i < 3; i++) recordRun(store, { hours: 8, kills: 0, used: [id] }, NOW + i);
  assert.equal(lessonStats(store)[0].flagged, false, 'no runs without it');
  assert.equal(lessonStats(store)[0].avgWithout, null);
  recordRun(store, { hours: 5, kills: 0, used: [] }, NOW + 9);
  assert.equal(lessonStats(store)[0].flagged, false, 'with it was longer');
});

test('review prompt carries the log, the run stats and the final situation', async () => {
  const { percept, memory } = loadFixture('v2-bleeding.json');
  const input = {
    log: [{ t: '12:00:01', kind: 'decide', text: 'model b1 ENTER walking in' }, { t: '12:00:09', kind: 'death', text: 'Run ended.' }],
    run: { hours: 19.5, kills: 6 },
    digestText: 'Day 1, 14:00, daytime. Outside.',
    final: { day: 1, hour: 14 },
    known: [{ when: 'night', text: 'Be inside before dark.' }],
  };
  const text = reviewPrompt(input);
  assert.match(text, /Survived 19\.5 game hours, 6 kills, died on day 1 at 14:00/);
  assert.match(text, /\[12:00:01\] decide: model b1 ENTER walking in/);
  assert.match(text, /Day 1, 14:00, daytime/);
  assert.match(text, /\(night\) Be inside before dark\./);
  assert.ok(percept && memory);

  let seen;
  const out = await reviewDeath(async (req) => {
    seen = req;
    return { raw: JSON.stringify({ lessons: [{ when: 'bleeding', text: 'Bandage before opening another door.' }, { when: 'zzz', text: 'Not allowed trigger here.' }] }) };
  }, input);
  assert.equal(seen.system, REVIEW_SYSTEM);
  assert.deepEqual(seen.schema, reviewSchema());
  assert.deepEqual(out.lessons, [{ when: 'bleeding', text: 'Bandage before opening another door.' }]);
  assert.equal(out.rejected.length, 1);
});

test('review schema allows only the fixed triggers and 3 lessons', () => {
  const s = reviewSchema();
  assert.deepEqual(s.properties.lessons.items.properties.when.enum, LESSON_TAGS);
  assert.equal(s.properties.lessons.maxItems, 3);
  for (const t of LESSON_TAGS) assert.ok(REVIEW_SYSTEM.includes(`- ${t}:`), t);
});
