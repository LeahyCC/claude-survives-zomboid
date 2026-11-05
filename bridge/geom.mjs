// Plain tile maths. +x is east, +y is south, as in the percept.

export function dist(ax, ay, bx = 0, by = 0) {
  return Math.hypot(ax - bx, ay - by);
}

const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

export function compass(dx, dy) {
  if (Math.hypot(dx, dy) < 1) return 'here';
  const turn = Math.atan2(dy, dx) / (Math.PI / 4);
  return COMPASS[((Math.round(turn) % 8) + 8) % 8];
}

// Shortest distance from point p to the segment a-b.
export function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// A point `length` tiles from the origin, pointing away from the given offsets.
export function awayFrom(points, length) {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    const d = Math.hypot(p.dx, p.dy) || 1;
    sx -= p.dx / d;
    sy -= p.dy / d;
  }
  const n = Math.hypot(sx, sy);
  if (n < 1e-6) return null;
  return { dx: Math.round((sx / n) * length), dy: Math.round((sy / n) * length) };
}
