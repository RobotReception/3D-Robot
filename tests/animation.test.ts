import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makeRobot, run, lp } from "./helpers/robot";
import { BUILTIN_CLIPS } from "../src/engine/library";
import { rawLimits, quatToEuler, eulerOrderFor } from "../src/engine/rig";
import { CHANNELS } from "../src/engine/clips";

const REQUIRED_STATES = ["idle", "listening", "thinking", "happy", "sad", "surprised", "greeting", "pointing", "error", "goodbye"];

describe("animation library", () => {
  it("provides every required state (speaking/walking/turning are driven by speech + locomotion)", async () => {
    const r = await makeRobot();
    for (const n of REQUIRED_STATES) expect(r.animation.has(n), n).toBe(true);
    expect(r.listAnimations()).toEqual(expect.arrayContaining(["walking", "turning", ...REQUIRED_STATES]));
  });

  it("every clip actually moves bones, and stays inside the joint limits and without NaN", async () => {
    for (const def of BUILTIN_CLIPS) {
      const r = await makeRobot();
      r.playAnimation(def.name, { emotion: false });
      let moved = 0;
      const rest = new Map<string, THREE.Quaternion>();
      for (const b of r.joints.names) rest.set(b, r.joints.bone(b).quaternion.clone());
      const steps = Math.ceil((def.loop ? 6 : def.duration) * 30);
      for (let i = 0; i < steps; i++) {
        r.update(1 / 30);
        for (const b of r.joints.names) {
          const q = r.joints.bone(b).quaternion;
          expect(Number.isFinite(q.x + q.y + q.z + q.w), `${def.name}:${b} NaN`).toBe(true);
          moved = Math.max(moved, q.angleTo(rest.get(b)!));
          if (/^(upperarm|forearm|hand|head|neck|spine|chest|clavicle|pelvis)/.test(b) || b.startsWith("finger")) {
            const e = quatToEuler(r.joints.currentDelta(b), eulerOrderFor(b));
            const l = rawLimits(b);
            const tol = 4; // slack (degrees) for blending idle+clip and Euler decomposition
            expect(e.x, `${def.name} ${b}.x`).toBeGreaterThanOrEqual(l.x[0] - tol);
            expect(e.x, `${def.name} ${b}.x`).toBeLessThanOrEqual(l.x[1] + tol);
            expect(e.z, `${def.name} ${b}.z`).toBeGreaterThanOrEqual(l.z[0] - tol);
            expect(e.z, `${def.name} ${b}.z`).toBeLessThanOrEqual(l.z[1] + tol);
            expect(e.y, `${def.name} ${b}.y`).toBeGreaterThanOrEqual(l.y[0] - tol);
            expect(e.y, `${def.name} ${b}.y`).toBeLessThanOrEqual(l.y[1] + tol);
          }
        }
      }
      expect(moved, `${def.name} should move something`).toBeGreaterThan(0.02);
    }
  });

  it("one-shot clips return to idle by themselves", async () => {
    const r = await makeRobot();
    const h = r.playAnimation("greeting");
    expect(r.animation.isPlaying("greeting")).toBe(true);
    let ended = false;
    void h.finished.then(() => (ended = true));
    run(r, 5);
    await new Promise((r) => setTimeout(r, 0));
    expect(ended).toBe(true);
    expect(r.animation.isPlaying("greeting")).toBe(false);
    expect(r.animation.active().armR).toEqual(["idle"]);
  });

  it("crossfades smoothly: no pose pops between consecutive frames", async () => {
    const r = await makeRobot();
    run(r, 1);
    r.playAnimation("greeting");
    let prev = r.joints.bone("upperarm_R").quaternion.clone();
    let maxStep = 0;
    for (let i = 0; i < 90; i++) {
      r.update(1 / 60);
      const q = r.joints.bone("upperarm_R").quaternion;
      maxStep = Math.max(maxStep, q.angleTo(prev));
      prev = q.clone();
    }
    expect(maxStep).toBeLessThan(0.1); // < 6 degrees per frame at 60 fps (a 78 deg raise in 0.55 s)
  });

  it("speed multiplier changes playback rate", async () => {
    const a = await makeRobot();
    const b = await makeRobot();
    b.setSpeed(2);
    a.playAnimation("surprised", { emotion: false });
    b.playAnimation("surprised", { emotion: false });
    run(a, 1.0);
    run(b, 1.0);
    expect(a.animation.isPlaying("surprised")).toBe(true);
    expect(b.animation.isPlaying("surprised")).toBe(false); // finished in <1 s at 2x
  });
});

describe("conflict handling & parallel animation", () => {
  it("higher-priority animations own a channel; lower ones are rejected, not mixed", async () => {
    const r = await makeRobot();
    run(r, 0.2);
    const p = r.playAnimation("pointing"); // priority 8
    expect(p.accepted).toContain("armR");
    const g = r.playAnimation("greeting"); // priority 6, wants armR too
    expect(g.rejected).toContain("armR");
    expect(g.accepted).not.toContain("armR");
    expect(r.animation.ownerOf("armR")!.name).toBe("pointing");
    // forced takeover is explicit
    const f = r.playAnimation("greeting", { force: true });
    expect(f.accepted).toContain("armR");
  });

  it("blocked requests emit an event", async () => {
    const r = await makeRobot();
    const blocked: string[] = [];
    r.on("animation:blocked", (e) => blocked.push(e.name));
    r.playAnimation("pointing");
    r.playAnimation("greeting");
    expect(blocked).toContain("greeting");
  });

  it("compatible animations run together on disjoint channels (speak + point + look)", async () => {
    const r = await makeRobot();
    r.speak({ text: "Look over there, I would like to show you something very interesting on the wall", tts: false });
    run(r, 0.6);
    const left = r.animation.ownerOf("armL")!;
    expect(left.name).toBe("talkL");
    r.playAnimation("pointing"); // takes armR + head, leaves armL talking
    r.lookAt({ x: 2, y: 1.3, z: 2 });
    run(r, 0.8);
    const act = r.animation.active();
    expect(act.armR[0]).toBe("pointing");
    expect(act.armL[0]).toBe("talkL");
    expect(r.speaking).toBe(true);
    expect(r.gaze.angles.headYaw).toBeGreaterThan(5);
  });

  it("a paused lower-priority loop resumes after the interrupting clip ends", async () => {
    const r = await makeRobot();
    r.speak({ text: "hello there my friend how are you today, it is really wonderful to see you again after such a long time", tts: false });
    run(r, 0.5);
    expect(r.animation.ownerOf("armR")!.name).toBe("talkR");
    r.playAnimation("pointing");
    run(r, 0.5);
    expect(r.animation.ownerOf("armR")!.name).toBe("pointing");
    run(r, 3.0);
    expect(r.speaking).toBe(true);
    expect(r.animation.ownerOf("armR")!.name).toBe("talkR");
  });

  it("walking arm-swing does not fight gesturing arms", async () => {
    const r = await makeRobot();
    r.playAnimation("pointing", { loop: true } as never);
    r.locomotion.walkForward(0.8);
    run(r, 1.5);
    // the pointing arm (R) is still raised in front while the free arm swings
    expect(lp(r, "hand_R").z).toBeGreaterThan(0.2);
  });

  it("channels list is complete and unknown animations fail loudly", async () => {
    const r = await makeRobot();
    expect(CHANNELS).toHaveLength(6);
    expect(() => r.playAnimation("moonwalk")).toThrow(/Unknown animation/);
  });
});
