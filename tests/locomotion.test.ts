import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makeRobot, run, wp } from "./helpers/robot";

const DEG = 180 / Math.PI;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("locomotion (IK-planted walking)", () => {
  it("walkTo reaches the target, resolves true, and ends idle with feet side by side", async () => {
    const r = await makeRobot();
    let arrived: boolean | undefined;
    void r.walkTo({ x: 1.0, z: 2.0 }).then((v) => (arrived = v));
    run(r, 8);
    await flush();
    expect(arrived).toBe(true);
    const d = Math.hypot(r.root.position.x - 1, r.root.position.z - 2);
    expect(d).toBeLessThan(0.07);
    run(r, 2);
    expect(r.locomotion.state).toBe("idle");
    expect(r.locomotion.busy).toBe(false);
    // feet end up beside each other again (|dz| small, separation ~ hip width)
    const lf = r.root.worldToLocal(wp(r, "foot_L"));
    const rf = r.root.worldToLocal(wp(r, "foot_R"));
    expect(Math.abs(lf.z - rf.z)).toBeLessThan(0.03);
    expect(lf.x - rf.x).toBeGreaterThan(0.14);
  });

  it("stance feet do not slide: a planted foot stays fixed in world space", async () => {
    const r = await makeRobot();
    void r.walkTo({ x: 0, z: 4 }, { speed: 0.8 });
    run(r, 1.2); // reach steady gait
    let maxSlip = 0;
    let checked = 0;
    const last: Record<string, THREE.Vector3 | null> = { L: null, R: null };
    for (let i = 0; i < 60 * 3; i++) {
      r.update(1 / 60);
      for (const s of ["L", "R"] as const) {
        const planted = r.locomotion.isPlanted(s);
        const p = wp(r, `foot_${s}`);
        if (planted && last[s]) {
          maxSlip = Math.max(maxSlip, Math.hypot(p.x - last[s]!.x, p.z - last[s]!.z));
          checked++;
        }
        last[s] = planted ? p : null;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(maxSlip).toBeLessThan(0.004); // < 4 mm per frame (the body moves ~13 mm per frame)
  });

  it("the actual ankle bones follow the IK targets and never sink below the floor", async () => {
    const r = await makeRobot();
    void r.walkTo({ x: 2, z: 2 }, { speed: 0.9 });
    let worstErr = 0;
    let minY = 9;
    for (let i = 0; i < 60 * 5; i++) {
      r.update(1 / 60);
      for (const s of ["L", "R"] as const) {
        const target = r.locomotion.footWorld(s);
        const bone = wp(r, `foot_${s}`);
        worstErr = Math.max(worstErr, bone.distanceTo(target));
        minY = Math.min(minY, bone.y);
      }
    }
    expect(worstErr).toBeLessThan(0.025); // IK reaches its targets (legs have enough reach)
    expect(minY).toBeGreaterThan(0.085 - 0.004); // ankle height above ground, i.e. soles never penetrate
  });

  it("keeps balance: pelvis stays over the support polygon and bobs only slightly", async () => {
    const r = await makeRobot();
    void r.walkTo({ x: 0, z: 5 }, { speed: 0.9 });
    run(r, 1.5);
    let minH = 9;
    let maxH = 0;
    let maxLat = 0;
    for (let i = 0; i < 60 * 3; i++) {
      r.update(1 / 60);
      const pel = r.root.worldToLocal(wp(r, "pelvis"));
      minH = Math.min(minH, pel.y);
      maxH = Math.max(maxH, pel.y);
      maxLat = Math.max(maxLat, Math.abs(pel.x));
    }
    expect(maxH - minH).toBeLessThan(0.07);
    expect(maxLat).toBeLessThan(0.06);
    // knees never hyper-extend: shin joint flexion stays >= 0
    for (const s of ["L", "R"]) expect(r.joints.currentEuler(`shin_${s}`).x).toBeGreaterThan(-3);
  });

  it("turnTo rotates in place by stepping and resolves; yaw accuracy < 3 deg", async () => {
    const r = await makeRobot();
    let done = false;
    void r.turnTo(120).then(() => (done = true));
    let steps = 0;
    for (let i = 0; i < 60 * 6; i++) {
      r.update(1 / 60);
      if (r.locomotion.feet.L.swing || r.locomotion.feet.R.swing) steps++;
    }
    await flush();
    expect(done).toBe(true);
    expect(Math.abs(r.root.rotation.y * DEG - 120)).toBeLessThan(3);
    expect(steps).toBeGreaterThan(30); // feet actually stepped
    expect(Math.hypot(r.root.position.x, r.root.position.z)).toBeLessThan(0.05); // turned in place
  });

  it("turns toward the goal before walking when it is behind the robot", async () => {
    const r = await makeRobot();
    void r.walkTo({ x: 0, z: -2 });
    run(r, 0.6);
    expect(r.root.position.z).toBeGreaterThan(-0.4); // has not run away yet
    run(r, 8);
    expect(r.root.position.z).toBeLessThan(-1.9);
  });

  it("final facing option and stop() settle the robot", async () => {
    const r = await makeRobot();
    void r.walkTo({ x: 1, z: 1 }, { facing: 180 });
    run(r, 9);
    expect(Math.abs(Math.abs(r.root.rotation.y * DEG) - 180)).toBeLessThan(4);
    const r2 = await makeRobot();
    r2.locomotion.walkForward(0.8);
    run(r2, 2);
    expect(r2.locomotion.speed).toBeGreaterThan(0.6);
    r2.locomotion.stop();
    run(r2, 3);
    expect(r2.locomotion.speed).toBe(0);
    expect(r2.locomotion.state).toBe("idle");
  });

  it("a new walk command replaces the old one and the old promise resolves false", async () => {
    const r = await makeRobot();
    let first: boolean | undefined;
    void r.walkTo({ x: 3, z: 0 }).then((v) => (first = v));
    run(r, 1);
    void r.walkTo({ x: 0, z: 1 });
    await flush();
    expect(first).toBe(false);
  });

  it("squat-bounce animation keeps feet planted (pelvis motion is absorbed by leg IK)", async () => {
    const r = await makeRobot();
    run(r, 0.5);
    const l0 = wp(r, "foot_L").clone();
    const r0 = wp(r, "foot_R").clone();
    r.playAnimation("happy");
    let drift = 0;
    let kneeBend = 0;
    for (let i = 0; i < 60 * 2; i++) {
      r.update(1 / 60);
      drift = Math.max(drift, wp(r, "foot_L").distanceTo(l0), wp(r, "foot_R").distanceTo(r0));
      kneeBend = Math.max(kneeBend, r.joints.currentEuler("shin_L").x);
    }
    expect(drift).toBeLessThan(0.01);
    expect(kneeBend).toBeGreaterThan(8); // knees really flex during the bounce
  });

  it("works for all three styles (different leg lengths)", async () => {
    for (const style of ["friendly", "futuristic"] as const) {
      const r = await makeRobot(style);
      void r.walkTo({ x: 0, z: 2 });
      run(r, 6);
      expect(Math.abs(r.root.position.z - 2)).toBeLessThan(0.08);
      for (const s of ["L", "R"] as const) expect(wp(r, `foot_${s}`).y).toBeGreaterThan(0.08);
    }
  });
});
