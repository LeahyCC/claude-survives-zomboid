// Numbers into short words a small model reads easily. Formatting only.

export function level(x) {
  const v = Number(x) || 0;
  if (v >= 0.8) return 'critical';
  if (v >= 0.6) return 'high';
  if (v >= 0.4) return 'some';
  if (v >= 0.2) return 'low';
  return 'none';
}

export function percent(x) {
  return `${Math.round((Number(x) || 0) * 100)}%`;
}

export function tiles(d) {
  const n = Math.round(Number(d) || 0);
  return n === 1 ? '1 tile' : `${n} tiles`;
}

const SIDE = { L: 'left', R: 'right' };
const PART = {
  Hand: 'hand', ForeArm: 'forearm', UpperArm: 'upper arm', UpperLeg: 'thigh', LowerLeg: 'shin',
  Foot: 'foot', Head: 'head', Neck: 'neck', Groin: 'groin', Torso_Upper: 'chest', Torso_Lower: 'belly',
};

// BodyPartType names like Hand_L into "left hand".
export function partName(part) {
  const s = String(part || '');
  if (PART[s]) return PART[s];
  const m = /^(.*)_([LR])$/.exec(s);
  if (m && PART[m[1]]) return `${SIDE[m[2]]} ${PART[m[1]]}`;
  return s.replace(/_/g, ' ').toLowerCase() || 'body';
}

const WOUND_WORDS = [
  ['bite', 'bite'], ['bleed', 'bleeding'], ['deep', 'deep wound'], ['glass', 'glass in it'],
  ['lac', 'cut'], ['scratch', 'scratch'],
];

export function woundText(w) {
  const kinds = WOUND_WORDS.filter(([k]) => w && w[k]).map(([, word]) => word);
  const tail = w && w.bandaged ? (w.dirty ? ', dirty bandage' : ', bandaged') : '';
  return `${kinds.join(' and ') || 'hurt'} on the ${partName(w && w.part)}${tail}`;
}

export function count(n, one, many = `${one}s`) {
  const v = Math.round(Number(n) || 0);
  return `${v} ${v === 1 ? one : many}`;
}

export function clock(hour) {
  const h = Math.max(0, Math.min(23, Math.round(Number(hour) || 0)));
  return `${String(h).padStart(2, '0')}:00`;
}

export function list(items, max = 4) {
  const xs = items.filter(Boolean);
  if (xs.length <= max) return xs.join(', ');
  return `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`;
}
