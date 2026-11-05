// A short plain report from the two logs: how often the brain agreed with Colin's nudges, what he
// said was missing, which orders fail, and which choices were followed by damage or death.
//
//   node bridge/tools/review.mjs                      everything in bridge/decisions.jsonl and nudges.jsonl
//   node bridge/tools/review.mjs --since 2026-11-04   only lines from that date on
//   node bridge/tools/review.mjs --decisions a.jsonl --nudges b.jsonl
//
// Reads the files only. Docs: docs/eval.md.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLog } from '../jsonl.mjs';
import { joinRecords, harm } from '../decisions.mjs';
import { situationOfCompact, situationLabel } from '../nudges.mjs';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Hit points lost in one choice's window that count as "followed by damage".
export const DAMAGE_MIN = 5;
const TOP = 8;
// Two missing-option notes are one request when this share of their words match.
const SAME_NOTE = 0.5;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'there', 'was', 'were', 'should', 'could', 'would', 'have', 'has', 'not', 'option', 'one', 'from', 'but', 'into', 'her', 'she']);

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function words(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

function similar(a, b) {
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared) >= SAME_NOTE;
}

// Notes that say the same thing in different words end up together. Biggest group first.
export function groupMissing(nudges) {
  const groups = [];
  for (const n of nudges) {
    const text = String(n.missing || '').trim();
    if (!text) continue;
    const w = words(text);
    const g = groups.find((x) => similar(x.words, w) || x.texts[0].toLowerCase() === text.toLowerCase());
    if (g) {
      g.texts.push(text);
      g.situations.add(n.situation || '?');
    } else {
      groups.push({ words: w, texts: [text], situations: new Set([n.situation || '?']) });
    }
  }
  return groups.sort((a, b) => b.texts.length - a.texts.length);
}

function agreement(nudges) {
  const picked = nudges.filter((n) => n.pick);
  const all = { agreed: 0, total: picked.length };
  const by = new Map();
  for (const n of picked) {
    // Compared by the option's key, because b1 means a different house each turn.
    const agreed = !!(n.brain && (n.brain.key ? n.brain.key === n.pickKey : n.brain.id === n.pick));
    const s = n.situation || '?';
    const row = by.get(s) || { agreed: 0, total: 0 };
    row.total += 1;
    if (agreed) {
      row.agreed += 1;
      all.agreed += 1;
    }
    by.set(s, row);
  }
  return { all, by };
}

export function failures(records) {
  const byVerb = new Map();
  for (const r of records) {
    const o = r.outcome;
    if (!o || (o.result !== 'done' && o.result !== 'failed')) continue;
    const row = byVerb.get(r.verb) || { verb: r.verb, total: 0, failed: 0, why: new Map() };
    row.total += 1;
    if (o.result === 'failed') {
      row.failed += 1;
      const why = o.why || 'no reason';
      row.why.set(why, (row.why.get(why) || 0) + 1);
    }
    byVerb.set(r.verb, row);
  }
  return [...byVerb.values()].filter((r) => r.failed).sort((a, b) => b.failed - a.failed || b.failed / b.total - a.failed / a.total);
}

export function harmful(records) {
  const byChoice = new Map();
  for (const r of records) {
    if (!r.sent || !r.after) continue;
    const key = `${r.verb} by ${r.by}${r.rule ? ` (${r.rule})` : ''}`;
    const row = byChoice.get(key) || { key, n: 0, damaged: 0, chased: 0, died: 0 };
    row.n += 1;
    if (harm(r) >= DAMAGE_MIN) row.damaged += 1;
    if (r.after.chased) row.chased += 1;
    if (r.after.died) row.died += 1;
    byChoice.set(key, row);
  }
  return [...byChoice.values()].filter((r) => r.damaged || r.died)
    .sort((a, b) => b.died - a.died || b.damaged / b.n - a.damaged / a.n || b.n - a.n);
}

// Death lines grouped by cause, most common first. A run can have two lines (the bridge guesses at
// once, and the mod's record may arrive a second later), so the newest line per run is the one kept.
function latestDeaths(lines) {
  const byRun = new Map();
  let anon = 0;
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!isObj(l) || l.t !== 'death') continue;
    byRun.set(l.run || `no-run-${anon++}`, l);
  }
  return [...byRun.values()];
}

// A death line that says "unknown" with full hp and nothing in the last 10 seconds is the log
// stopping (the game was closed), not a death. Real deaths always have a hit or a drain behind them.
export function isSessionEnd(d) {
  // A line with no samples at all (source "none") has no hp field; that is the same case.
  return String(d.cause || 'unknown') === 'unknown' && (d.hp === undefined || num(d.hp) >= 100)
    && !num(d.hpLost10) && !num(d.zClose) && !num(d.zChasing) && !num(d.zAdj);
}

export function sessionEnds(lines) {
  return latestDeaths(lines).filter(isSessionEnd);
}

export function deathsByCause(lines) {
  const groups = new Map();
  for (const d of latestDeaths(lines)) {
    if (isSessionEnd(d)) continue;
    const cause = String(d.cause || 'unknown');
    const g = groups.get(cause) || { cause, n: 0, jobs: new Map(), close: 0, chasing: 0, hp: 0, mod: 0 };
    g.n += 1;
    const job = d.job || d.order || 'none';
    g.jobs.set(job, (g.jobs.get(job) || 0) + 1);
    g.close += num(d.zClose);
    g.chasing += num(d.zChasing);
    g.hp += num(d.hpLost10);
    if (d.source === 'mod') g.mod += 1;
    groups.set(cause, g);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n || a.cause.localeCompare(b.cause));
}

// How long after a call the second escape check looks, and how late a line may be and still count.
const LATE_CHECK_MS = 30_000;
const LATE_SLACK_MS = 60_000;

// The log has no line at exactly 30 seconds, so the check uses the next line that shows the
// chasers: a decision line (its percept), a reflex call (its facts) or an out line. Each is
// { ms, escaped }, sorted by time.
function stateTimeline(list) {
  const at = [];
  for (const l of list) {
    if (!isObj(l)) continue;
    const ms = Date.parse(l.at);
    if (!Number.isFinite(ms)) continue;
    if (l.t === 'decision' && isObj(l.percept) && isObj(l.percept.z)) {
      const near3 = (Array.isArray(l.percept.zList) ? l.percept.zList : []).filter((z) => isObj(z) && num(z.d, 99) <= 3).length;
      at.push({ ms, escaped: num(l.percept.z.chasing) === 0 && near3 === 0 });
    } else if (l.t === 'reflex' && l.kind === 'call' && isObj(l.f)) {
      at.push({ ms, escaped: num(l.f.chasers) === 0 && num(l.f.within3) === 0 });
    } else if (l.t === 'reflex' && l.kind === 'out' && typeof l.escaped === 'boolean') {
      at.push({ ms, escaped: l.escaped });
    }
  }
  return at.sort((a, b) => a.ms - b.ms);
}

// Reflex lines (the mod's call and out lines, copied in by reflexlog.mjs) grouped by stance.
// Only calls with a chaser at the time count, and the climb waits are left out: a SNEAK call never
// had a chaser, and most CLIMB calls are the wait during a climb already under way (ENTER's own
// window climb), so counting them made both look like escapes. The left-out calls are returned
// beside the rows so nothing is hidden. Escaped is checked 5 seconds on (the out line) and 30
// seconds on (the next line that shows the chasers, or "no data"). Most taken first.
export function reflexSplit(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const timeline = stateTimeline(list);
  const rows = new Map();
  const left = { noChaser: 0, climbWait: 0 };
  const counted = new Set();
  const row = (stance) => {
    const key = String(stance || 'NONE');
    if (!rows.has(key)) rows.set(key, { stance: key, calls: 0, outs: 0, escaped: 0, chased: 0, hits: 0, hpLost: 0, kills: 0, late: 0, escapedLate: 0, noLate: 0, why: new Map() });
    return rows.get(key);
  };
  for (const l of list) {
    if (!isObj(l) || l.t !== 'reflex' || l.kind !== 'call') continue;
    // Old lines have no facts; those still count rather than vanish.
    const chasers = isObj(l.f) ? num(l.f.chasers) : 1;
    const wait = String(l.stance) === 'CLIMB' && (l.act === 'wait' || l.why === 'climbing');
    if (wait) {
      left.climbWait += 1;
      continue;
    }
    if (chasers <= 0) {
      left.noChaser += 1;
      continue;
    }
    counted.add(l.id);
    const r = row(l.stance);
    r.calls += 1;
    const why = l.why || '-';
    r.why.set(why, (r.why.get(why) || 0) + 1);
    const want = Date.parse(l.at) + LATE_CHECK_MS;
    const hit = Number.isFinite(want) ? timeline.find((t) => t.ms >= want && t.ms <= want + LATE_SLACK_MS) : null;
    if (!hit) {
      r.noLate += 1;
    } else {
      r.late += 1;
      if (hit.escaped) r.escapedLate += 1;
    }
  }
  for (const l of list) {
    if (!isObj(l) || l.t !== 'reflex' || l.kind !== 'out' || !counted.has(l.id)) continue;
    const r = row(l.stance);
    r.outs += 1;
    if (l.escaped) r.escaped += 1;
    if (l.chased) r.chased += 1;
    r.hits += num(l.hits);
    r.hpLost += num(l.hpLost);
    r.kills += num(l.kills);
  }
  return { rows: [...rows.values()].sort((a, b) => b.calls - a.calls || a.stance.localeCompare(b.stance)), left };
}

export function reflexByStance(lines) {
  return reflexSplit(lines).rows;
}

// Escape loops that hit their limit, and the turns the reflex handed back to the brain
// (docs/combat.md, "Stuck in a chase"). A loop-limit call is a reflex call line whose why starts
// with "stuck"; its act says what she did next: climb, hold (stand and shove) or a walk on while
// the brain was asked. Its out line, five seconds on, says whether that got her away. A hand-back
// is a decision line with a handback field; its own outcome says whether the order worked.
export function stuckInChase(lines, records) {
  const list = Array.isArray(lines) ? lines : [];
  const outs = new Map();
  for (const l of list) if (isObj(l) && l.t === 'reflex' && l.kind === 'out') outs.set(l.id, l);
  const next = new Map();
  let limit = 0;
  for (const l of list) {
    if (!isObj(l) || l.t !== 'reflex' || l.kind !== 'call' || !String(l.why || '').startsWith('stuck')) continue;
    limit += 1;
    const what = l.act === 'climb' ? 'climbed' : l.act === 'hold' ? 'stood and shoved' : 'walked on and asked the brain';
    const row = next.get(what) || { what, n: 0, outs: 0, escaped: 0 };
    row.n += 1;
    const o = outs.get(l.id);
    if (o) {
      row.outs += 1;
      if (o.escaped) row.escaped += 1;
    }
    next.set(what, row);
  }
  const back = (Array.isArray(records) ? records : []).filter((r) => r.handback);
  const verbs = new Map();
  const result = { done: 0, failed: 0, other: 0 };
  let lost = 0;
  for (const r of back) {
    const v = r.sent ? r.verb : 'nothing sent';
    verbs.set(v, (verbs.get(v) || 0) + 1);
    const res = r.outcome && r.outcome.result;
    if (res === 'done' || res === 'failed') result[res] += 1;
    else if (r.sent) result.other += 1;
    lost += harm(r);
  }
  return { limit, next: [...next.values()].sort((a, b) => b.n - a.n), back: { n: back.length, verbs, result, lost } };
}

// How the outcomes of a set of decisions went. Failures count orders that reported; damage, chasing
// and death count orders whose follow-up window has closed, because only those have an `after`.
function outcomeTally(recs) {
  const t = { orders: 0, reported: 0, failed: 0, followed: 0, damaged: 0, chased: 0, died: 0 };
  for (const r of recs) {
    if (!r.sent) continue;
    t.orders += 1;
    const o = r.outcome;
    if (o && (o.result === 'done' || o.result === 'failed')) {
      t.reported += 1;
      if (o.result === 'failed') t.failed += 1;
    }
    if (r.after) {
      t.followed += 1;
      if (harm(r) >= DAMAGE_MIN) t.damaged += 1;
      if (r.after.chased) t.chased += 1;
      if (r.after.died) t.died += 1;
    }
  }
  return t;
}

// The critic's lines (critic.mjs) against how things went. A decision with no critic line was not
// reviewed (the critic was off, busy, paused or timed out) and is left out of every count.
export function criticReview(records) {
  const reviewed = records.filter((r) => isObj(r.critic));
  const flagged = reviewed.filter((r) => r.critic.flag);
  const calm = reviewed.filter((r) => !r.critic.flag);
  const bySituation = new Map();
  const byWho = new Map();
  for (const r of reviewed) {
    const s = situationLabel(situationOfCompact(r.percept));
    const row = bySituation.get(s) || { n: 0, flagged: 0 };
    row.n += 1;
    if (r.critic.flag) row.flagged += 1;
    bySituation.set(s, row);
    const who = r.by === 'policy' && r.rule ? `policy (${r.rule})` : r.by || '?';
    const w = byWho.get(who) || { n: 0, flagged: 0 };
    w.n += 1;
    if (r.critic.flag) w.flagged += 1;
    byWho.set(who, w);
  }
  return {
    decisions: records.length, reviewed: reviewed.length,
    agreed: reviewed.filter((r) => r.critic.agree).length, flagged: flagged.length,
    flagAt: reviewed.length ? num(reviewed[reviewed.length - 1].critic.flagAt) : null,
    bySituation, byWho,
    afterFlagged: outcomeTally(flagged), afterCalm: outcomeTally(calm),
  };
}

function tallyText(t) {
  if (!t.orders) return 'no orders sent';
  const part = (a, b, what) => `${what} ${a} of ${b} (${pct(a, b)})`;
  return [
    `${t.orders} orders`, part(t.failed, t.reported, 'failed'), part(t.damaged, t.followed, `lost ${DAMAGE_MIN} hp or more`),
    part(t.chased, t.followed, 'a zombie started chasing'), part(t.died, t.followed, 'died within 5 min'),
  ].join('; ');
}

const since = (iso, from) => !from || (typeof iso === 'string' && Date.parse(iso) >= from);

// decisions and nudges are the raw lines. from is a Date or null.
export function buildReport({ decisions = [], nudges = [], from = null }) {
  const fromMs = from ? from.getTime() : null;
  const records = joinRecords(decisions).filter((r) => since(r.at, fromMs));
  const notes = (Array.isArray(nudges) ? nudges : []).filter((n) => isObj(n) && n.t === 'nudge' && since(n.at, fromMs));
  const out = [];
  const line = (s = '') => out.push(s);

  const sent = records.filter((r) => r.sent);
  const byWho = (who) => records.filter((r) => r.by === who).length;
  line(`Review${from ? ` since ${from.toISOString().slice(0, 10)}` : ''}`);
  line(`  ${records.length} decisions (policy ${byWho('policy')}, model ${byWho('model')}, nudge ${byWho('nudge')}), ${sent.length} sent an order, ${records.filter((r) => r.outcome).length} have a result.`);
  line(`  ${notes.length} nudges, ${notes.filter((n) => n.pick).length} with a pick, ${notes.filter((n) => n.missing).length} saying an option is missing.`);

  line();
  line('Deaths by cause');
  const deathLines = (Array.isArray(decisions) ? decisions : []).filter((l) => isObj(l) && l.t === 'death' && since(l.at, fromMs));
  const deaths = deathsByCause(deathLines);
  const ends = sessionEnds(deathLines);
  if (!deaths.length && !ends.length) line('  No deaths logged.');
  for (const g of deaths.slice(0, TOP)) {
    const jobs = [...g.jobs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([j, n]) => `${j} ${n}`).join(', ');
    const avg = (v) => String(Math.round((10 * v) / g.n) / 10);
    const thin = g.mod < g.n ? ` (${g.n - g.mod} from the bridge's own guess)` : '';
    line(`  ${g.n}x ${g.cause}: doing ${jobs}; ${avg(g.close)} close and ${avg(g.chasing)} chasing at the end, ${avg(g.hp)} hp lost in the last 10 s${thin}`);
  }
  if (ends.length) line(`  Not deaths: ${ends.length} session end${ends.length > 1 ? 's' : ''} (full hp or no record, nothing in the last 10 s, the log just stopped).`);

  line();
  line('Reflex by stance (calls with a chaser only; escaped: nothing chasing within 10 and nothing within 3, at 5 s and at 30 s)');
  const inRange = (Array.isArray(decisions) ? decisions : []).filter((l) => isObj(l) && since(l.at, fromMs));
  const { rows: stances, left } = reflexSplit(inRange);
  const anyLeft = left.noChaser + left.climbWait > 0;
  if (!stances.length && !anyLeft) line('  No reflex lines logged.');
  for (const r of stances) {
    const why = [...r.why].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ${n}`).join(', ');
    const late = r.late ? `${r.escapedLate} of ${r.late} (${pct(r.escapedLate, r.late)})${r.noLate ? `, ${r.noLate} no data` : ''}` : 'no data';
    line(`  ${r.stance}: ${r.calls} calls (${why || '-'}); escaped at 5 s ${r.escaped} of ${r.outs} (${pct(r.escaped, r.outs)}), at 30 s ${late}; ${r.hits} hits, ${Math.round(r.hpLost)} hp lost, ${r.kills} kills`);
  }
  if (anyLeft || stances.length) line(`  Left out: ${left.noChaser} calls with no chaser, ${left.climbWait} climb waits.`);

  line();
  line('Stuck in a chase (an escape loop hit its limit, or the reflex held the brain off for a minute)');
  const stuck = stuckInChase(inRange, records);
  if (!stuck.limit) {
    line('  No escape loop hit its limit.');
  } else {
    const then = stuck.next.map((r) => `${r.what} ${r.n} (escaped ${r.escaped} of ${r.outs})`).join(', ');
    line(`  Loop limit hit ${stuck.limit} times. Then: ${then}.`);
  }
  if (!stuck.back.n) {
    line('  The brain was never handed a turn back.');
  } else {
    const b = stuck.back;
    const verbs = [...b.verbs].sort((x, y) => y[1] - x[1]).map(([v, n]) => `${v} ${n}`).join(', ');
    line(`  Turns handed back to the brain ${b.n}: ${verbs}. Orders done ${b.result.done}, failed ${b.result.failed}, replaced or unfinished ${b.result.other}; ${Math.round(b.lost)} hp lost during and after.`);
  }

  line();
  line("Critic (Jev's second opinion, logged only, it never steers her)");
  const c = criticReview(records);
  if (!c.reviewed) {
    line('  No critic lines. Set TYPESAFE_API_KEY to turn it on (docs/brain.md, "Critic").');
  } else {
    line(`  ${c.reviewed} of ${c.decisions} decisions were reviewed. Jev's top pick matched the brain's ${c.agreed} times (${pct(c.agreed, c.reviewed)}).`);
    line(`  Flagged (the brain's pick got under ${Math.round(100 * c.flagAt)}% of Jev's probability): ${c.flagged} (${pct(c.flagged, c.reviewed)}).`);
    line('  Flags by situation');
    for (const [s, row] of [...c.bySituation].sort((a, b) => b[1].flagged - a[1].flagged || b[1].n - a[1].n).slice(0, TOP)) {
      line(`    ${s}: ${row.flagged} of ${row.n} (${pct(row.flagged, row.n)})`);
    }
    line('  Flags by who decided');
    for (const [who, row] of [...c.byWho].sort((a, b) => b[1].n - a[1].n).slice(0, TOP)) {
      line(`    ${who}: ${row.flagged} of ${row.n} (${pct(row.flagged, row.n)})`);
    }
    line('  How it went after (a flag that predicts trouble shows up as a higher rate on the first line)');
    line(`    flagged:   ${tallyText(c.afterFlagged)}`);
    line(`    unflagged: ${tallyText(c.afterCalm)}`);
  }

  line();
  line('Agreement with your nudges');
  const { all, by } = agreement(notes);
  if (!all.total) {
    line('  No nudges with a pick yet.');
  } else {
    line(`  Overall: the brain had your pick ${all.agreed} of ${all.total} times (${pct(all.agreed, all.total)}).`);
    for (const [s, row] of [...by].sort((a, b) => b[1].total - a[1].total).slice(0, TOP)) {
      line(`  ${s}: ${row.agreed} of ${row.total} (${pct(row.agreed, row.total)})`);
    }
  }

  line();
  line('Missing options');
  const groups = groupMissing(notes);
  if (!groups.length) line('  None noted.');
  for (const g of groups.slice(0, TOP)) {
    line(`  ${g.texts.length}x "${g.texts[0]}"${g.texts.length > 1 ? ` (and ${g.texts.length - 1} like it)` : ''}, in: ${[...g.situations].slice(0, 3).join('; ')}`);
  }

  line();
  line('Orders that fail most');
  const fails = failures(records);
  if (!fails.length) line('  No failed orders.');
  for (const r of fails.slice(0, TOP)) {
    const why = [...r.why].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ${n}`).join(', ');
    line(`  ${r.verb}: ${r.failed} of ${r.total} failed (${pct(r.failed, r.total)}): ${why}`);
  }

  line();
  line(`Choices followed by damage (${DAMAGE_MIN} hp or more in the order and the minute after) or death within 5 minutes`);
  const bad = harmful(records);
  if (!bad.length) line('  None.');
  for (const r of bad.slice(0, TOP)) {
    line(`  ${r.key}: ${r.damaged} damaged and ${r.died} died of ${r.n}${r.chased ? `, a zombie started chasing ${r.chased}x` : ''}`);
  }
  return out.join('\n');
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(args = process.argv.slice(2)) {
  const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dFile = flag(args, 'decisions') || process.env.PZ_DECISIONS_FILE || path.join(bridge, 'decisions.jsonl');
  const nFile = flag(args, 'nudges') || process.env.PZ_NUDGES_FILE || path.join(bridge, 'nudges.jsonl');
  const raw = flag(args, 'since');
  let from = null;
  if (args.includes('--since')) {
    from = raw ? new Date(raw) : new Date(NaN);
    if (Number.isNaN(from.getTime())) {
      console.error('--since needs a date such as 2026-11-04.');
      return 1;
    }
  }
  console.log(buildReport({ decisions: readLog(dFile), nudges: readLog(nFile), from }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
