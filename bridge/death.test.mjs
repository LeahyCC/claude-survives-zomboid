import test from 'node:test';
import assert from 'node:assert/strict';
import { guessDeath, guessFrom, cleanSample, sampleFromPercept, samplesFromRecord, hpLost, describe, CAUSES } from './death.mjs';

// Ten seconds of a calm character, one sample a second. A fixture changes the last few.
const calm = (o = {}) => ({
  hp: 90, bleeding: 0, wounds: 0, bite: false, infected: false, hunger: 0.2, thirst: 0.2,
  zClose: 0, zAdj: 0, zChasing: 0, nearest: 20, inside: false, z: 0, reflex: 'none', ...o,
});
// Ten samples, with the given overrides applied to the last n.
function ten(tailFixes, lastN = tailFixes.length) {
  const out = Array.from({ length: 10 }, () => calm());
  tailFixes.forEach((fix, i) => { out[10 - lastN + i] = calm(fix); });
  return out;
}

test('bitten in a fight: the reflex was swinging when a zombie was on her', () => {
  const s = ten([
    { hp: 90, zAdj: 1, zChasing: 1, reflex: 'fight', job: 'GOTO' },
    { hp: 70, zAdj: 2, zChasing: 2, reflex: 'fight', job: 'GOTO' },
    { hp: 40, zAdj: 2, zChasing: 2, reflex: 'fight', bite: true, job: 'GOTO' },
    { hp: 0, zAdj: 3, zChasing: 3, reflex: 'fight', bite: true, job: 'GOTO' },
  ]);
  const g = guessDeath(s);
  assert.equal(g.cause, 'bitten in a fight');
  assert.equal(g.facts.job, 'GOTO');
  assert.equal(g.facts.zAdj, 3);
  assert.equal(g.facts.zChasing, 3);
  assert.equal(g.facts.hpLost10, 90);
  assert.equal(g.facts.reflex, 'fight');
});

test('overrun while fleeing: the reflex was running and they caught her', () => {
  const g = guessDeath(ten([
    { hp: 80, zAdj: 0, zChasing: 4, reflex: 'flee' },
    { hp: 60, zAdj: 1, zChasing: 4, reflex: 'flee' },
    { hp: 30, zAdj: 2, zChasing: 4, reflex: 'flee' },
    { hp: 0, zAdj: 2, zChasing: 4, reflex: 'flee' },
  ]));
  assert.equal(g.cause, 'overrun while fleeing');
  assert.equal(g.facts.reflex, 'flee');
});

test('overrun while entering a building: an ENTER order or job was running', () => {
  const g = guessDeath(ten([
    { hp: 90, zAdj: 0, zChasing: 2, reflex: 'flee', order: 'ENTER', status: 'running', job: 'ENTER' },
    { hp: 50, zAdj: 2, zChasing: 2, reflex: 'flee', order: 'ENTER', status: 'running', job: 'ENTER' },
    { hp: 0, zAdj: 2, zChasing: 2, reflex: 'none', order: 'ENTER', status: 'running', job: 'ENTER' },
  ]));
  assert.equal(g.cause, 'overrun while entering a building');
  assert.equal(g.facts.job, 'ENTER');
});

test('a failed ENTER from a minute ago does not make it an entering death', () => {
  const g = guessDeath(ten([
    { hp: 90, zAdj: 1, zChasing: 1, reflex: 'flee', order: 'ENTER', status: 'failed' },
    { hp: 40, zAdj: 2, zChasing: 2, reflex: 'flee', order: 'ENTER', status: 'failed' },
    { hp: 0, zAdj: 2, zChasing: 2, reflex: 'flee', order: 'ENTER', status: 'failed' },
  ]));
  assert.equal(g.cause, 'overrun while fleeing');
});

test('bitten while busy: a zombie got her in the middle of a SEARCH, with no reflex acting', () => {
  const g = guessDeath(ten([
    { hp: 90, job: 'SEARCH', order: 'SEARCH', status: 'running' },
    { hp: 60, job: 'SEARCH', order: 'SEARCH', status: 'running', zAdj: 1, zChasing: 1, bite: true },
    { hp: 0, job: 'SEARCH', order: 'SEARCH', status: 'running', zAdj: 2, zChasing: 2, bite: true },
  ]));
  assert.equal(g.cause, 'bitten while busy');
  assert.equal(g.facts.job, 'SEARCH');
  assert.equal(g.facts.zAdj, 2);
});

test('plain bitten: a zombie was on her and nothing names why', () => {
  const g = guessDeath(ten([{ hp: 50, zAdj: 1, zChasing: 1 }, { hp: 0, zAdj: 1, zChasing: 1 }]));
  assert.equal(g.cause, 'bitten');
});

test('a chaser and fast hp loss count as a zombie hit even when no sample caught one in reach', () => {
  const g = guessDeath(ten([{ hp: 90, zChasing: 2 }, { hp: 60, zChasing: 2 }, { hp: 0, zChasing: 2 }]));
  assert.equal(g.cause, 'bitten');
});

test('infection: infected, and no zombie anywhere near the end', () => {
  const s = ten([{ hp: 40, infected: true, bite: true }, { hp: 20, infected: true, bite: true }, { hp: 0, infected: true, bite: true }]);
  const g = guessDeath(s);
  assert.equal(g.cause, 'infection');
  assert.equal(g.facts.infected, true);
});

test('an infected character killed by a zombie is bitten, not infection', () => {
  const g = guessDeath(ten([{ infected: true, hp: 30, zAdj: 2, zChasing: 2, reflex: 'fight' }, { infected: true, hp: 0, zAdj: 2, zChasing: 2, reflex: 'fight' }]));
  assert.equal(g.cause, 'bitten in a fight');
});

// The 2026-11-05 death, from local_death.txt: bitten earlier (infected stays set for life), hp
// draining 0.6 a second from bleeding, ENTER running, four chasing, the nearest 7 to 8 tiles off.
test('chasers close and hp lost reads as overrun, not infection, even with the infected flag set', () => {
  const drip = (hp, zChasing = 2) => ({
    hp, infected: true, bite: true, scratch: true, bleeding: 2, wounds: 3, zClose: 2, zAdj: 0, zChasing, nearest: 7.4,
    job: 'ENTER', order: 'ENTER', status: 'running', reflex: 'none',
  });
  const hps = [6.3, 5.6, 4.9, 4.3, 3.6, 2.9, 2.3, 1.6, 0.9, 0.3];
  const g = guessDeath([...hps.map((hp) => drip(hp)), drip(0, 4)]);
  assert.equal(g.cause, 'overrun while entering a building');
  assert.equal(g.facts.zChasing, 4);
  assert.equal(g.facts.infected, true);
  // Not entering: the reflex mode picks the word.
  const fled = [...hps.map((hp) => ({ ...drip(hp), job: undefined, order: undefined, reflex: 'flee' })), { ...drip(0, 4), job: undefined, order: undefined, reflex: 'flee' }];
  assert.equal(guessDeath(fled).cause, 'overrun while fleeing');
});

test('chasers close but barely hurt is not overrun, and hurt with no chaser close is not either', () => {
  const calmBleed = (o) => calm({ infected: true, bite: true, bleeding: 0, ...o });
  // Hp fell 3 over the ring with a chaser close: below the line, so the infection reading stands.
  const barely = guessDeath(Array.from({ length: 10 }, (_, i) => calmBleed({ hp: Math.max(0, 3 - i * 0.3), zClose: 1, zChasing: 1 })));
  assert.equal(barely.cause, 'infection');
  // Hurt, chasers far (nothing inside 10): no one was close.
  const far = guessDeath(Array.from({ length: 10 }, (_, i) => calmBleed({ hp: 40 - i * 2, zChasing: 2 })));
  assert.equal(far.cause, 'infection');
  assert.notEqual(far.cause, 'overrun while entering a building');
  assert.notEqual(far.cause, 'overrun while fleeing');
});

test('an infected flag with bleeding and no chaser is a bleed, not infection', () => {
  const g = guessDeath(ten([{ hp: 20, infected: true, bite: true, bleeding: 2 }, { hp: 0, infected: true, bite: true, bleeding: 2 }]));
  assert.equal(g.cause, 'bled out');
});

test('bled out: bleeding at the end, no zombie near', () => {
  const g = guessDeath(ten([{ hp: 50, bleeding: 2, wounds: 2 }, { hp: 20, bleeding: 2, wounds: 2 }, { hp: 0, bleeding: 2, wounds: 2 }]));
  assert.equal(g.cause, 'bled out');
  assert.equal(g.facts.bleeding, 2);
});

test('starved: hunger at the limit, no zombie near', () => {
  assert.equal(guessDeath(ten([{ hp: 10, hunger: 0.99 }, { hp: 0, hunger: 0.99 }])).cause, 'starved');
});

test('thirst: thirst at the limit, no zombie near', () => {
  assert.equal(guessDeath(ten([{ hp: 10, thirst: 0.98 }, { hp: 0, thirst: 0.98 }])).cause, 'thirst');
});

test('fell: z dropped and the hp went with it', () => {
  const g = guessDeath(ten([{ hp: 90, z: 1 }, { hp: 90, z: 1 }, { hp: 20, z: 0 }, { hp: 0, z: 0 }]));
  assert.equal(g.cause, 'fell');
});

test('going down the stairs is not a fall', () => {
  const g = guessDeath(ten([{ hp: 90, z: 1 }, { hp: 90, z: 0 }, { hp: 90, z: 0 }]));
  assert.equal(g.cause, 'unknown');
});

test('unknown only when nothing fits', () => {
  assert.equal(guessDeath(ten([{ hp: 0 }])).cause, 'unknown');
  assert.equal(guessDeath([]).cause, 'unknown');
  assert.equal(guessDeath(null).cause, 'unknown');
  assert.equal(guessDeath([]).facts.source, 'none');
});

test('every cause the guesser returns is on the list', () => {
  for (const s of [
    ten([{ zAdj: 1, reflex: 'fight' }]), ten([{ zAdj: 1, reflex: 'flee' }]), ten([{ zAdj: 1, job: 'ENTER' }]),
    ten([{ infected: true }]), ten([{ bleeding: 1 }]), ten([{ hunger: 1 }]), ten([{ thirst: 1 }]), ten([{}]),
  ]) assert.ok(CAUSES.includes(guessDeath(s).cause));
});

test('a bite long ago is not a cause when she starved', () => {
  const g = guessDeath(ten([{ hp: 20, hunger: 0.99, bite: true, wounds: 1 }, { hp: 0, hunger: 0.99, bite: true, wounds: 1 }]));
  assert.equal(g.cause, 'starved');
});

test('hp lost counts every drop and not healing', () => {
  assert.equal(hpLost([{ hp: 100 }, { hp: 80 }, { hp: 90 }, { hp: 70 }]), 40);
  assert.equal(hpLost([{ hp: 100 }, {}, { hp: 70 }]), 0);
});

test('the mod record wins over the bridge tail, and keeps the game text', () => {
  const record = {
    id: 'a1', hours: 40.7, ring: ten([{ hp: 50, zAdj: 2, zChasing: 2, reflex: 'fight' }]), text: 'You died on day 3.',
    final: calm({ hp: 0, zAdj: 2, zChasing: 2, reflex: 'fight' }),
  };
  const g = guessFrom({ record, tail: ten([{ bleeding: 3 }]) });
  assert.equal(g.cause, 'bitten in a fight');
  assert.equal(g.facts.source, 'mod');
  assert.equal(g.facts.text, 'You died on day 3.');
  assert.equal(guessFrom({ tail: ten([{ bleeding: 3 }]) }).facts.source, 'bridge');
  assert.equal(guessFrom({ record: { ring: [] }, tail: [] }).cause, 'unknown');
});

test('cleanSample keeps known keys with the right types and drops junk', () => {
  assert.deepEqual(cleanSample({ hp: '55', bite: 1, job: 'ENTER', evil: 'x', thirst: 'abc', order: '' }), { hp: 55, bite: true, job: 'ENTER' });
  assert.equal(cleanSample({ nope: 1 }), null);
  assert.equal(cleanSample('x'), null);
  assert.equal(samplesFromRecord({ ring: [null, { hp: 5 }], final: { hp: 1 } }).length, 2);
});

test('a sample from a plain percept has the facts the percept holds', () => {
  const s = sampleFromPercept({
    hp: 40, z: 0, hunger: 0.1, thirst: 0.1, bleeding: 1, wounds: [{ part: 'Hand_L', bite: true }], zClose: 3, zChasing: 2,
    zList: [{ d: 1.5, chase: true }, { d: 6 }], inBldg: { id: 'B1' }, outside: false, res: { verb: 'SEARCH', status: 'running' },
  });
  assert.equal(s.zAdj, 1);
  assert.equal(s.bite, true);
  assert.equal(s.inside, true);
  assert.equal(s.order, 'SEARCH');
  assert.equal(sampleFromPercept(null), null);
});

test('describe gives one short line', () => {
  const g = guessDeath(ten([{ hp: 80, zAdj: 2, zChasing: 3, reflex: 'flee', job: 'SEARCH' }, { hp: 0, zAdj: 2, zChasing: 3, reflex: 'flee', job: 'SEARCH' }]));
  assert.equal(describe(g.facts), 'SEARCH, 2 close, 3 chasing, -90 hp in 10 s');
  assert.equal(describe(null), '');
});

// The run that started this card (docs/roadmap.md): chased, "away", ENTER a new house, chased again,
// ENTER failed with 20 hp lost, then SEARCH with no real weapon, then dead.
test('the 40 hour run: a SEARCH with a zombie on her ends as bitten while busy', () => {
  const g = guessDeath(ten([
    { hp: 80, order: 'ENTER', status: 'failed', zChasing: 2, reflex: 'flee' },
    { hp: 80, order: 'SEARCH', status: 'running', job: 'SEARCH', zChasing: 2, zAdj: 0, inside: true },
    { hp: 50, order: 'SEARCH', status: 'running', job: 'SEARCH', zChasing: 2, zAdj: 1, inside: true },
    { hp: 0, order: 'SEARCH', status: 'running', job: 'SEARCH', zChasing: 3, zAdj: 2, inside: true },
  ]));
  assert.equal(g.cause, 'bitten while busy');
  assert.equal(g.facts.inside, true);
});

test('a bleed-out is "bled out" before the infected flag, thirst and hunger are looked at', () => {
  const bleed = { hp: 30, bleeding: 2, wounds: 2 };
  const read = (extra) => guessDeath(ten([{ ...bleed, ...extra }, { ...bleed, hp: 0, ...extra }])).cause;
  assert.equal(read({ infected: true, bite: true }), 'bled out');
  assert.equal(read({ thirst: 1 }), 'bled out');
  assert.equal(read({ hunger: 1 }), 'bled out');
  assert.equal(read({ infected: true, thirst: 1, hunger: 1 }), 'bled out');
  // Without the bleeding the old readings stand.
  const dry = (extra) => guessDeath(ten([{ hp: 30, ...extra }, { hp: 0, ...extra }])).cause;
  assert.equal(dry({ infected: true, bite: true }), 'infection');
  assert.equal(dry({ thirst: 1 }), 'thirst');
  assert.equal(dry({ hunger: 1 }), 'starved');
  // A zombie on her still wins over the bleed.
  const hit = { ...bleed, zAdj: 1, zChasing: 1, reflex: 'fight' };
  assert.equal(guessDeath(ten([hit, { ...hit, hp: 0 }])).cause, 'bitten in a fight');
});
