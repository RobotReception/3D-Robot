import { describe, expect, it } from "vitest";
import { makeRobot, run } from "./helpers/robot";
import { clearance, findPath, isFree, nearestFree, resolve, segmentFree, type World } from "../src/engine/world";
import { lobbyWorld } from "../src/viewer/environments/lobby";

const room: World = { bounds: { minX: -4, maxX: 4, minZ: -4, maxZ: 4 }, boxes: [{ minX: -1, maxX: 1, minZ: -0.3, maxZ: 0.3 }], circles: [{ x: 2.5, z: 2, r: 0.4 }] };

describe("world geometry", () => {
  it("resolve pushes a point out of boxes, circles and walls, and slides along them", () => {
    const a = resolve(room, 0, 0.2, 0.3); // inside the box -> pushed out through the nearest face
    expect(isFree(room, a.x, a.z, 0.3 - 1e-6)).toBe(true);
    const b = resolve(room, 3.9, 0, 0.3); // too close to the right wall
    expect(b.x).toBeCloseTo(3.7, 5);
    const c = resolve(room, 2.5, 2.5, 0.3); // overlapping the plant
    expect(Math.hypot(c.x - 2.5, c.z - 2)).toBeGreaterThanOrEqual(0.7 - 1e-6);
    const d = resolve(room, 1.2, 0.35, 0.3); // sliding past a box corner keeps the tangential position
    expect(d.hit).toBe(true);
    expect(clearance(room, d.x, d.z, 0.3)).toBeGreaterThanOrEqual(-1e-6);
  });

  it("findPath routes around the box with clearance and straight when nothing is in the way", () => {
    expect(findPath(room, { x: -3, z: 2 }, { x: 3, z: 3 }, 0.3)!.length).toBe(1);
    const p = findPath(room, { x: 0, z: -2 }, { x: 0, z: 2 }, 0.3)!;
    expect(p.length).toBeGreaterThan(1);
    let prev = { x: 0, z: -2 };
    for (const q of p) {
      expect(segmentFree(room, prev, q, 0.28)).toBe(true);
      prev = q;
    }
    expect(p[p.length - 1]).toEqual({ x: 0, z: 2 });
  });

  it("findPath returns null when the target is walled in; nearestFree rescues a target inside furniture", () => {
    const walled: World = { bounds: { minX: -4, maxX: 4, minZ: -4, maxZ: 4 }, boxes: [{ minX: 1, maxX: 3, minZ: 1, maxZ: 1.2 }, { minX: 1, maxX: 3, minZ: 2.8, maxZ: 3 }, { minX: 1, maxX: 1.2, minZ: 1, maxZ: 3 }, { minX: 2.8, maxX: 3, minZ: 1, maxZ: 3 }], circles: [] };
    expect(findPath(walled, { x: -2, z: -2 }, { x: 2, z: 2 }, 0.3)).toBeNull();
    const n = nearestFree(room, 0, 0, 0.3)!;
    expect(isFree(room, n.x, n.z, 0.3)).toBe(true);
    expect(Math.hypot(n.x, n.z)).toBeLessThan(0.7);
  });
});

describe("robot with a world", () => {
  it("walkTo a point BEHIND the desk goes around it (route with detour) and never enters desk, plants or walls", async () => {
    const world = lobbyWorld();
    const r = await makeRobot("concierge");
    r.world = world;
    r.root.position.set(0, 0, 0);
    r.locomotion.plantFeetNeutral();
    const done = r.walkTo({ x: 0, z: -4.95 }); // the strip between the desk and the back wall
    expect(r.lastWalk.unreachable).toBe(false);
    expect(r.lastWalk.route.length).toBeGreaterThan(1); // a detour, not a straight line through the desk
    let arrived = false;
    void done.then((ok) => (arrived = ok));
    let minClear = Infinity, maxZ = -Infinity;
    for (let i = 0; i < 60 * 60 && r.locomotion.state !== "idle"; i++) {
      r.update(1 / 60);
      minClear = Math.min(minClear, clearance(world, r.root.position.x, r.root.position.z, r.locomotion.radius));
      maxZ = Math.max(maxZ, r.root.position.z);
    }
    expect(minClear).toBeGreaterThanOrEqual(-0.01);
    run(r, 1);
    await done;
    expect(arrived).toBe(true);
    expect(Math.hypot(r.root.position.x - 0, r.root.position.z + 4.95)).toBeLessThan(0.12);
  });

  it("a target inside the desk is moved to the nearest free spot (event) and the robot stops in front of the desk", async () => {
    const world = lobbyWorld();
    const r = await makeRobot("concierge");
    r.world = world;
    const events: unknown[] = [];
    r.on("walk:blocked", (e) => events.push(e));
    void r.walkTo({ x: 0, z: -4 });
    expect(r.lastWalk.adjusted).toBe(true);
    expect(events.length).toBe(1);
    for (let i = 0; i < 60 * 25 && r.locomotion.state !== "idle"; i++) r.update(1 / 60);
    expect(clearance(world, r.root.position.x, r.root.position.z, r.locomotion.radius)).toBeGreaterThanOrEqual(-0.01);
  });

  it("walkForward into the wall stops in front of it instead of passing through", async () => {
    const world = lobbyWorld();
    const r = await makeRobot("concierge");
    r.world = world;
    r.root.position.set(0, 0, 5);
    r.locomotion.plantFeetNeutral();
    r.locomotion.walkForward(0.8); // facing +Z: the front wall is at z=7.5
    for (let i = 0; i < 60 * 12; i++) r.update(1 / 60);
    expect(r.root.position.z).toBeLessThan(7.5 - r.locomotion.radius + 0.01);
    expect(r.root.position.z).toBeGreaterThan(6.5);
    expect(r.locomotion.state === "idle" || r.locomotion.speed < 0.05).toBe(true);
  });

  it("setting a world while the robot stands inside furniture moves it out; no world = unchanged behaviour", async () => {
    const r = await makeRobot("concierge");
    r.root.position.set(0, 0, -4); // inside the desk
    r.world = lobbyWorld();
    expect(clearance(lobbyWorld(), r.root.position.x, r.root.position.z, r.locomotion.radius)).toBeGreaterThanOrEqual(-1e-6);
    const free = await makeRobot("concierge");
    free.world = null;
    void free.walkTo({ x: 30, z: 0 });
    expect(free.lastWalk.adjusted).toBe(false);
  });
});
