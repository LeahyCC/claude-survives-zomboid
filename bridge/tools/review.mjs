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
