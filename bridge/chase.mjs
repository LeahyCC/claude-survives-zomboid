// How long the reflex has had a chase to itself, and when the brain gets a turn anyway.
//
// While a chaser is inside 10 tiles the bridge writes no order (senses.mjs, holdReason). That is
// right for a fight, and wrong for an escape that does not work: in the 2026-11-05 soak one
// zombie kept her on FLEE for 33 minutes and the brain never had a turn. So the hold is a
// loan. It ends when the reflex says it has nothing left (percept reflex.stuck), or when it has
// had a small chase to itself for HANDBACK_MS and nobody is hurting her. The brain then picks
// from a short escape menu (options.mjs, escapeOptions). No I/O here; the bridge passes the
// time in.

import { holdReason, zombies, HOLD_CHASE_R } from './senses.mjs';

export const HANDBACK_MS = 60_000;
// The hold must be off this long before the chase counts as over.
export const CHASE_CLEAR_MS = 15_000;
// A second hand-back waits this long after the last, so a menu that does not help is not
// asked again every second.
export const HANDBACK_AGAIN_MS = 45_000;
// Chasers (or standing zombies close by) the escape menu is for. A pack is the reflex's.
export const SMALL_CHASE = 2;
// A reflex that is fighting or shoving is working. Its stance counts while it is this fresh.
const WORKING = new Set(['FIGHT', 'SHOVE']);
const STANCE_FRESH_S = 10;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function createChaseClock() {
  let since = null;
  let lastHold = 0;
  let lastBack = -Infinity;

  return {
    // One call per look at a new percept, before asking whether a hand-back is due.
    observe(p, now) {
      if (!holdReason(p)) return;
      // The hold was off long enough for the chase to be over (or the bridge was not looking).
      if (since === null || now - lastHold >= CHASE_CLEAR_MS) since = now;
      lastHold = now;
    },

    ownedMs(now) {
      return since === null || now - lastHold >= CHASE_CLEAR_MS ? 0 : now - since;
    },

    // null, or { why, ms }: the brain should get this turn. Only while the hold is on.
    due(p, now) {
      if (!holdReason(p)) return null;
      if (now - lastBack < HANDBACK_AGAIN_MS) return null;
      const ms = this.ownedMs(now);
      const r = (p && p.reflex) || {};
      if (r.stuck === true) return { why: 'the reflex has no way out left', ms };
      if (ms < HANDBACK_MS) return null;
      const near = zombies(p).filter((z) => !z.down && !z.crawl && z.d <= HOLD_CHASE_R).length;
      if (near > SMALL_CHASE) return null;
      if (num(r.hits60) > 0) return null;
      if (WORKING.has(String(r.stance)) && num(r.age, 999) <= STANCE_FRESH_S) return null;
      return { why: `the reflex has had this chase for ${Math.round(ms / 1000)} seconds`, ms };
    },

    // The bridge calls this when it plans a hand-back turn.
    handedBack(now) {
      lastBack = now;
    },
  };
}
