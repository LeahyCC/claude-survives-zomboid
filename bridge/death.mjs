// Why she died. The mod keeps one sample a second for the last 10 seconds and writes them out when
// player 0 dies (mods/.../Death.lua, docs/percept.md). This turns those samples into a plain cause
// and the facts behind it. No I/O here.
//
// The same guesser reads samples built from the bridge's own recent percepts, for a death the mod
// record did not reach (an old mod, or the bridge started late). Those are thinner: no reflex mode,
// no infection, no temperature.

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Samples kept from the bridge's own percepts, about one a second.
export const TAIL = 10;
const CRITICAL = 0.95;
// A zombie this close (tiles) is on her. The mod counts zAdj with the same line.
export const ADJ_R = 3;
// The seconds at the end that decide who was on her and what she was doing.
const END = 5;
// The reflex reading uses fewer: what she was doing when it ended, not a few seconds earlier.
const REFLEX_END = 3;
// A fall costs at least this much hp in the sample it lands in or the one after.
const FALL_HP = 10;
// Hp lost in the last END seconds that, with a chaser about, means a zombie got to her even if no
// sample caught it within reach.
const HIT_HP = 10;
// Hp lost across the whole ring that, with a chaser inside 10 tiles, is damage a chase did. A bite
// wound that bleeds drains hp for minutes after the zombie is 8 tiles behind (the 2026-11-05 death:
// 6 hp over the ring, nearest chaser 7 tiles, four chasing).
const HURT_HP = 5;

export const CAUSES = [
  'bitten in a fight', 'overrun while fleeing', 'overrun while entering a building', 'bitten while busy',
  'bitten', 'infection', 'bled out', 'starved', 'thirst', 'fell', 'unknown',
];

// Verbs whose job keeps her standing in one spot. A bite during one is "while busy".
const BUSY = new Set(['SEARCH', 'LOOT', 'DRINK', 'FILL', 'EAT', 'SLEEP', 'BANDAGE', 'WEARBAG', 'SECURE', 'REST', 'DROP']);

const flag = (v) => (v === undefined || v === null ? undefined : !!v);
const text = (v, max = 24) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

// One sample from the mod's ring. Unknown keys are dropped, a missing key stays missing.
export function cleanSample(raw) {
  if (!isObj(raw)) return null;
  const s = {};
  for (const k of ['hp', 'bleeding', 'wounds', 'infect', 'hunger', 'thirst', 'sick', 'foodSick', 'poison', 'temp', 'zClose', 'zAdj', 'zChasing', 'nearest', 'z']) {
    if (raw[k] !== undefined && Number.isFinite(Number(raw[k]))) s[k] = Number(raw[k]);
  }
  for (const k of ['bite', 'scratch', 'infected', 'inside']) {
    const v = flag(raw[k]);
    if (v !== undefined) s[k] = v;
  }
  for (const k of ['job', 'order', 'status', 'reflex']) {
    const v = text(raw[k]);
    if (v) s[k] = v;
  }
  return Object.keys(s).length ? s : null;
}

// A sample from a live percept, for the bridge's own tail. The percept has less than the mod's ring.
export function sampleFromPercept(p) {
  if (!isObj(p)) return null;
  const zs = Array.isArray(p.zList) ? p.zList : [];
  const res = isObj(p.res) ? p.res : {};
  const near = zs.length ? Math.min(...zs.map((q) => num(q && q.d, 99))) : num(p.zDist, -1) >= 0 ? num(p.zDist) : 99;
  const ws = Array.isArray(p.wounds) ? p.wounds : [];
  const s = {
    hp: num(p.hp, 100), z: num(p.z), hunger: num(p.hunger), thirst: num(p.thirst),
    bleeding: num(p.bleeding), wounds: ws.length,
    bite: ws.some((w) => w && w.bite), scratch: ws.some((w) => w && w.scratch),
    zClose: num(p.zClose), zChasing: num(p.zChasing), nearest: near,
    zAdj: zs.length ? zs.filter((q) => num(q && q.d, 99) <= ADJ_R).length : near <= ADJ_R ? 1 : 0,
    inside: !!(p.inBldg && p.inBldg.id != null && !p.outside),
  };
  if (res.verb) {
    s.order = text(res.verb);
    s.status = text(res.status);
  }
  return s;
}

// The samples of a mod record, oldest first, with the last one taken at the moment of death.
export function samplesFromRecord(rec) {
  if (!isObj(rec)) return [];
  const ring = (Array.isArray(rec.ring) ? rec.ring : []).map(cleanSample).filter(Boolean);
  const final = cleanSample(rec.final);
  return final ? [...ring, final] : ring;
}

const last = (a, n) => a.slice(Math.max(0, a.length - n));
const peak = (a, key) => a.reduce((m, s) => Math.max(m, num(s[key])), 0);
const any = (a, fn) => a.some(fn);

// Hp lost across the samples: every drop between two neighbours, healing not subtracted.
export function hpLost(samples) {
  let lost = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].hp;
    const b = samples[i].hp;
    if (a !== undefined && b !== undefined && b < a) lost += a - b;
  }
  return Math.round(lost * 10) / 10;
}

// The job and order running at the end, read from the newest sample that names one.
function lastJob(samples) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.job || s.order) return { job: s.job || null, order: s.order || null, status: s.status || null };
  }
  return { job: null, order: null, status: null };
}

// The cause, then the facts it rests on. Order matters, and each rule says why.
export function guessDeath(samples) {
  const all = (Array.isArray(samples) ? samples : []).filter(isObj);
  if (!all.length) return { cause: 'unknown', facts: { source: 'none', samples: 0 } };
  const end = last(all, END);
  const final = all[all.length - 1];
  const { job, order, status } = lastJob(end);
  const lost = hpLost(all);
  const lostEnd = hpLost(end);
  const adj = peak(end, 'zAdj');
  const chasing = peak(end, 'zChasing');
  const reflexes = last(all, REFLEX_END).map((s) => s.reflex);
  const fled = reflexes.filter((r) => r === 'flee').length;
  const fought = reflexes.filter((r) => r === 'fight').length;
  const entering = any(end, (s) => s.job === 'ENTER' || (s.order === 'ENTER' && s.status === 'running'));
  // Chasers close: at least one coming for her, and one inside 10 tiles.
  const pressed = chasing > 0 && peak(end, 'zClose') > 0;
  // A zombie was on her: one within reach in the last seconds, or hp falling fast with a chaser
  // about, or hurt at all with chasers close (the hp was the chase's even if the last bite was
  // earlier than the ring).
  const hit = adj > 0 || (chasing > 0 && lostEnd >= HIT_HP) || (pressed && lost >= HURT_HP);
  const bleedingEnd = any(end, (s) => num(s.bleeding) > 0);

  const facts = {
    job, order, status,
    zAdj: adj, zClose: peak(end, 'zClose'), zChasing: chasing,
    hpLost10: lost, hpLostEnd: lostEnd,
    inside: final.inside, reflex: fled > fought ? 'flee' : fought ? 'fight' : final.reflex || null,
    bleeding: num(final.bleeding), infected: !!final.infected,
    hunger: final.hunger, thirst: final.thirst, hp: final.hp, samples: all.length,
  };

  let cause = 'unknown';
  // A fall needs no zombie. Walking down stairs also drops z, so the hp lost has to go with it.
  const fell = all.some((s, i) => i > 0 && num(s.z) < num(all[i - 1].z)
    && (num(all[i - 1].hp) - num(all[Math.min(i + 1, all.length - 1)].hp)) >= FALL_HP);
  if (fell && !hit) cause = 'fell';
  else if (hit) {
    // Entering first: the doorway is where the walk is stopped. Then what the reflex was doing,
    // because that is the choice she made. A bite with neither is a bite while she was busy.
    if (entering) cause = 'overrun while entering a building';
    else if (fled > fought && fled > 0) cause = 'overrun while fleeing';
    else if (fought > 0) cause = 'bitten in a fight';
    else if (job && BUSY.has(job)) cause = 'bitten while busy';
    else cause = 'bitten';
  } else if (bleedingEnd) {
    // Before infection, thirst and hunger. A wound that bleeds takes her in minutes (hp 63 to 0 in
    // 4, hp 78 to 0 in 2 on 2026-11-05); the infected flag stays set for life after any bite, and
    // thirst or hunger drain too slowly to be what killed someone who was bleeding.
    cause = 'bled out';
  } else if (final.infected) {
    cause = 'infection';
  } else if (num(final.thirst) >= CRITICAL) cause = 'thirst';
  else if (num(final.hunger) >= CRITICAL) cause = 'starved';
  return { cause, facts };
}

// The record or the tail, whichever has something. The record wins: it has the reflex, the job
// and the moment of death.
export function guessFrom({ record, tail }) {
  const fromRecord = samplesFromRecord(record);
  if (fromRecord.length) {
    const g = guessDeath(fromRecord);
    g.facts.source = 'mod';
    if (isObj(record) && typeof record.text === 'string' && record.text) g.facts.text = record.text.slice(0, 120);
    return g;
  }
  const g = guessDeath(Array.isArray(tail) ? tail : []);
  if (g.facts.source !== 'none') g.facts.source = 'bridge';
  return g;
}

// One line of words for a table cell or a log: "SEARCH, 2 close, 1 chasing, -34 hp in 10 s".
export function describe(facts) {
  if (!isObj(facts)) return '';
  const bits = [];
  const what = facts.job || facts.order;
  if (what) bits.push(what);
  if (num(facts.zAdj)) bits.push(`${facts.zAdj} close`);
  if (num(facts.zChasing)) bits.push(`${facts.zChasing} chasing`);
  if (num(facts.hpLost10)) bits.push(`-${Math.round(facts.hpLost10)} hp in 10 s`);
  return bits.join(', ');
}
