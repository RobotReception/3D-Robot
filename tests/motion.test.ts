import { describe, expect, it } from "vitest";
import { makeRobot, run, lp, morph } from "./helpers/robot";
import { compileMotion, exportMotion, MOTION_SCHEMA } from "../src/engine/motionJson";
import { BUILTIN_CLIPS } from "../src/engine/library";
import { executeCommand } from "../src/engine/commands";

const wave = {
  name: "bigWave", description: "wave with the right hand", duration: 2.4, priority: 6,
  keys: [
    { t: 0, armR: { shoulder: 0, abduction: 0, elbow: 10, twist: 0 }, handR: "relaxed", head: { yaw: 0, roll: 0 } },
    { t: 0.5, armR: { shoulder: 10, abduction: 80, elbow: 96, twist: 78 }, handR: "open", head: { yaw: -10, roll: 6 } },
    { t: 1.1, armR: { elbow: 120 } },
    { t: 1.7, armR: { elbow: 80 } },
    { t: 2.4, armR: { shoulder: 0, abduction: 0, elbow: 10, twist: 0 }, handR: "relaxed", head: { yaw: 0, roll: 0 } },
  ],
  events: [{ t: 0.4, emotion: "happy" }, { t: 2.0, emotion: "neutral" }],
};

describe("JSON motions (AI-authorable)", () => {
  it("a valid motion compiles, registers, plays and moves the real bones", async () => {
    const r = await makeRobot();
    const res = r.registerMotion(wave);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(r.listMotions()).toEqual(["bigWave"]);
    const h = r.playAnimation("bigWave", { emotion: false });
    expect(h.accepted).toEqual(expect.arrayContaining(["armR", "fingersR", "head"]));
    run(r, 0.9);
    expect(lp(r, "hand_R").y).toBeGreaterThan(0.95); // hand raised
    expect(Math.abs(r.joints.currentEuler("finger_index_1_R").z)).toBeLessThan(10); // "open" hand
    run(r, 3);
    expect(r.animation.isPlaying("bigWave")).toBe(false);
  });

  it("events drive emotions at the right time", async () => {
    const r = await makeRobot();
    r.registerMotion(wave);
    r.playAnimation("bigWave");
    run(r, 0.2);
    expect(r.face.emotion.name).not.toBe("happy");
    run(r, 0.6);
    expect(r.face.emotion.name).toBe("happy");
    run(r, 0.4);
    expect(morph(r, "Mouth", "mouthSmile")).toBeGreaterThan(0.5);
  });

  it("reports precise errors (path + message) instead of throwing", () => {
    const bad = compileMotion({
      name: "Bad Name", duration: 100, priority: 11, easing: "bounce", surprise: 1,
      keys: [{ t: 0, armR: { shoulder: "up", flap: 3 }, head: { spin: 1 }, handL: { pinky: 1 } }, { t: 200 }],
    });
    expect(bad.ok).toBe(false);
    const paths = bad.errors.map((e) => e.path);
    for (const p of ["name", "duration", "priority", "easing", "surprise"]) expect(paths).toContain(p);
    const bad2 = compileMotion({ name: "okName", duration: 2, keys: [{ t: 0, armR: { shoulder: "up", flap: 3 }, head: { spin: 1 }, handL: { pinky: 1 }, raw: { thigh_L: [1, 2, 3] } }, { t: 1, torso: { yaw: 1 } }] });
    expect(bad2.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["keys[0].armR.shoulder", "keys[0].armR.flap", "keys[0].head.spin", "keys[0].handL.pinky", "keys[0].raw.thigh_L"]));
    for (const input of [null, "x", 5, [], { name: "okName", duration: 2 }, { name: "okName", duration: 2, keys: [{ t: 0 }, { t: 1 }] }]) {
      expect(() => compileMotion(input)).not.toThrow();
      expect(compileMotion(input).ok).toBe(false);
    }
  });

  it("clamps out-of-range angles to the natural limits and warns; warns about popping loops", () => {
    const res = compileMotion({
      name: "stretch", duration: 2, loop: true,
      keys: [{ t: 0, armL: { elbow: 0, abduction: 0 } }, { t: 1, armL: { elbow: 300, abduction: 170 }, pelvis: { y: -0.5 } }, { t: 2, armL: { elbow: 20, abduction: 0 } }],
    });
    expect(res.ok).toBe(true);
    const msgs = res.warnings.map((w) => w.path + " " + w.message).join("\n");
    expect(msgs).toMatch(/joint forearm_L/);
    expect(msgs).toMatch(/joint upperarm_L/);
    expect(msgs).toMatch(/pelvis/);
    expect(msgs).toMatch(/loop/);
    const mid = res.def!.pose(1, 0.5).joints!;
    expect(mid.forearm_L[0]).toBeGreaterThanOrEqual(-150); // clamped to -150
    expect(mid.upperarm_L[2]).toBeLessThanOrEqual(88);
  });

  it("protects built-ins, requires overwrite for duplicates", async () => {
    const r = await makeRobot();
    expect(r.registerMotion({ ...wave, name: "greeting" }).errors[0].message).toMatch(/built-in/);
    expect(r.registerMotion(wave).ok).toBe(true);
    expect(r.registerMotion(wave).ok).toBe(false);
    expect(r.registerMotion(wave, { overwrite: true }).ok).toBe(true);
  });

  it("every built-in clip exports to JSON and re-compiles to (nearly) the same pose", async () => {
    for (const def of BUILTIN_CLIPS) {
      const json = exportMotion(def);
      expect(json.keys.length).toBeLessThanOrEqual(240);
      const res = compileMotion({ ...json, name: "copy", priority: Math.max(1, json.priority ?? 6) });
      expect(res.errors, def.name).toEqual([]);
      let worst = 0;
      for (let i = 0; i <= 40; i++) {
        const t = (i / 40) * def.duration;
        const a = def.pose(t, t / def.duration).joints ?? {};
        const b = res.def!.pose(t, t / def.duration).joints ?? {};
        for (const bone of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const ea = a[bone] ?? [0, 0, 0];
          const eb = b[bone] ?? [0, 0, 0];
          for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(ea[k] - eb[k]));
        }
      }
      expect(worst, `${def.name} max joint deviation (deg)`).toBeLessThan(12);
    }
  });

  it("JSON commands: registerMotion (+play), listMotions, getMotion, getMotionSchema, errors", async () => {
    const r = await makeRobot();
    const ok = await executeCommand(r, { cmd: "registerMotion", motion: wave, play: true });
    expect(ok.ok).toBe(true);
    expect((ok.result as { played: string[] }).played).toContain("armR");
    expect(((await executeCommand(r, { cmd: "listMotions" })).result as { custom: string[] }).custom).toEqual(["bigWave"]);
    expect(((await executeCommand(r, { cmd: "getMotion", name: "bigWave" })).result as { name: string }).name).toBe("bigWave");
    expect(((await executeCommand(r, { cmd: "getMotion", name: "greeting" })).result as { keys: unknown[] }).keys.length).toBeGreaterThan(5);
    expect(((await executeCommand(r, { cmd: "getMotionSchema" })).result as { title: string }).title).toBe("RobotMotion");
    const bad = await executeCommand(r, { cmd: "registerMotion", motion: { name: "x" } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/invalid motion: .*duration/);
    expect(MOTION_SCHEMA.required).toEqual(["name", "duration", "keys"]);
  });
});
