/**
 * Walkable world for the locomotion controller: a bounding rectangle (walls) plus solid boxes and circles (furniture,
 * plants), all on the ground plane (x, z in metres). The robot is a disc of `radius`.
 *
 *  - `resolve` slides a position out of walls/obstacles (no tunnelling through, no sticking on corners)
 *  - `findPath` plans a route around obstacles (grid A* + line-of-sight smoothing) with clearance
 *  - `nearestFree` snaps an unreachable target (inside a desk, behind a wall...) to the closest standing spot
 */
export interface WorldBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export interface WorldCircle {
  x: number;
  z: number;
  r: number;
}
export interface World {
  /** walls: the robot centre must stay inside (null = unbounded) */
  bounds: WorldBox | null;
  boxes: WorldBox[];
  circles: WorldCircle[];
}
export interface Point2 {
  x: number;
  z: number;
}

export const emptyWorld = (): World => ({ bounds: null, boxes: [], circles: [] });

/** signed clearance of a point: > 0 free, < 0 inside something (distance to the nearest surface, shrunk by `radius`) */
export function clearance(w: World, x: number, z: number, radius: number): number {
  let c = Infinity;
  if (w.bounds) c = Math.min(c, x - w.bounds.minX, w.bounds.maxX - x, z - w.bounds.minZ, w.bounds.maxZ - z);
  for (const b of w.boxes) {
    const dx = Math.max(b.minX - x, 0, x - b.maxX);
    const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
    if (dx > 0 || dz > 0) c = Math.min(c, Math.hypot(dx, dz));
    else c = Math.min(c, -Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z)); // inside the box: negative depth
  }
  for (const k of w.circles) c = Math.min(c, Math.hypot(x - k.x, z - k.z) - k.r);
  return c - radius;
}

export const isFree = (w: World, x: number, z: number, radius: number) => clearance(w, x, z, radius) >= 0;

/** Push (x, z) out of every obstacle / back inside the walls. Returns the corrected point (`hit` = it moved). */
export function resolve(w: World, x: number, z: number, radius: number, out: { x: number; z: number; hit: boolean } = { x: 0, z: 0, hit: false }) {
  out.hit = false;
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    if (w.bounds) {
      const b = w.bounds;
      const nx = Math.min(Math.max(x, b.minX + radius), b.maxX - radius);
      const nz = Math.min(Math.max(z, b.minZ + radius), b.maxZ - radius);
      if (nx !== x || nz !== z) { x = nx; z = nz; moved = true; }
    }
    for (const b of w.boxes) {
      // closest point on the box to the centre
      const cx = Math.min(Math.max(x, b.minX), b.maxX);
      const cz = Math.min(Math.max(z, b.minZ), b.maxZ);
      let dx = x - cx, dz = z - cz;
      const d = Math.hypot(dx, dz);
      if (d >= radius) continue;
      if (d > 1e-6) {
        dx /= d; dz /= d;
        x = cx + dx * radius; z = cz + dz * radius;
      } else {
        // centre inside the box: leave through the nearest face
        const l = x - b.minX, r = b.maxX - x, t = z - b.minZ, bt = b.maxZ - z;
        const m = Math.min(l, r, t, bt);
        if (m === l) x = b.minX - radius; else if (m === r) x = b.maxX + radius; else if (m === t) z = b.minZ - radius; else z = b.maxZ + radius;
      }
      moved = true;
    }
    for (const k of w.circles) {
      let dx = x - k.x, dz = z - k.z;
      const d = Math.hypot(dx, dz), min = k.r + radius;
      if (d >= min) continue;
      if (d > 1e-6) { dx /= d; dz /= d; } else { dx = 1; dz = 0; }
      x = k.x + dx * min; z = k.z + dz * min;
      moved = true;
    }
    if (!moved) break;
    out.hit = true;
  }
  out.x = x;
  out.z = z;
  return out;
}

/** true when the straight segment keeps `radius` clearance everywhere */
export function segmentFree(w: World, a: Point2, b: Point2, radius: number, step = 0.05): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!isFree(w, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, radius)) return false;
  }
  return true;
}

/** closest free standing point to (x, z) (spiral search); null if the world has none nearby */
export function nearestFree(w: World, x: number, z: number, radius: number, maxDist = 3): Point2 | null {
  if (isFree(w, x, z, radius)) return { x, z };
  const r = resolve(w, x, z, radius);
  if (isFree(w, r.x, r.z, radius - 1e-3)) return { x: r.x, z: r.z };
  let best: Point2 | null = null, bd = Infinity;
  for (let d = 0.1; d <= maxDist && !best; d += 0.1) {
    const n = Math.ceil((Math.PI * 2 * d) / 0.08);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      if (isFree(w, px, pz, radius) && d < bd) { bd = d; best = { x: px, z: pz }; }
    }
  }
  return best;
}

/**
 * Route from `from` to `to` around obstacles. Returns the waypoints after `from` (the last one is `to`), or null if
 * `to` is unreachable. 8-connected A* on a 0.1 m grid over clearance-inflated obstacles, then line-of-sight smoothing
 * so the path is a few long straight legs (no staircase).
 */
export function findPath(w: World, from: Point2, to: Point2, radius: number, cell = 0.1): Point2[] | null {
  if (segmentFree(w, from, to, radius)) return [{ x: to.x, z: to.z }];
  const b = w.bounds ?? {
    minX: Math.min(from.x, to.x) - 4, maxX: Math.max(from.x, to.x) + 4,
    minZ: Math.min(from.z, to.z) - 4, maxZ: Math.max(from.z, to.z) + 4,
  };
  const nx = Math.max(2, Math.ceil((b.maxX - b.minX) / cell)), nz = Math.max(2, Math.ceil((b.maxZ - b.minZ) / cell));
  if (nx * nz > 400000) return null;
  const cx = (i: number) => b.minX + (i + 0.5) * cell, cz = (j: number) => b.minZ + (j + 0.5) * cell;
  const ix = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor((x - b.minX) / cell)));
  const iz = (z: number) => Math.min(nz - 1, Math.max(0, Math.floor((z - b.minZ) / cell)));
  const free = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) free[j * nx + i] = isFree(w, cx(i), cz(j), radius) ? 1 : 0;
  const start = iz(from.z) * nx + ix(from.x), goal = iz(to.z) * nx + ix(to.x);
  free[start] = 1; // the robot may start slightly inside the safety margin
  free[goal] = 1;
  const g = new Float32Array(nx * nz).fill(Infinity);
  const prev = new Int32Array(nx * nz).fill(-1);
  const closed = new Uint8Array(nx * nz);
  // binary heap on f = g + h
  const heap: [number, number][] = [];
  const push = (f: number, n: number) => {
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top[1];
  };
  const hx = goal % nx, hz = (goal / nx) | 0;
  const h = (n: number) => Math.hypot((n % nx) - hx, ((n / nx) | 0) - hz) * cell;
  g[start] = 0;
  push(h(start), start);
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  let found = false;
  while (heap.length) {
    const n = pop();
    if (closed[n]) continue;
    closed[n] = 1;
    if (n === goal) { found = true; break; }
    const ci = n % nx, cj = (n / nx) | 0;
    for (const [di, dj, c] of D) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      const m = j * nx + i;
      if (!free[m] || closed[m]) continue;
      if (di && dj && (!free[cj * nx + i] || !free[j * nx + ci])) continue; // no corner cutting
      const ng = g[n] + c * cell;
      if (ng < g[m]) { g[m] = ng; prev[m] = n; push(ng + h(m), m); }
    }
  }
  if (!found) return null;
  let cells: Point2[] = [];
  for (let n = goal; n !== -1; n = prev[n]) cells.push({ x: cx(n % nx), z: cz((n / nx) | 0) });
  cells.reverse();
  cells[0] = { x: from.x, z: from.z };
  cells[cells.length - 1] = { x: to.x, z: to.z };
  // line-of-sight smoothing (string pulling)
  const out: Point2[] = [];
  let a = 0;
  while (a < cells.length - 1) {
    let b2 = cells.length - 1;
    while (b2 > a + 1 && !segmentFree(w, cells[a], cells[b2], radius * 0.97)) b2--;
    out.push(cells[b2]);
    a = b2;
  }
  return out;
}
