import { describe, expect, it } from "vitest";
import { makeRobot, run, morph } from "./helpers/robot";
import { EMOTIONS } from "../src/engine/FaceController";

describe("face & emotions", () => {
  it("every emotion drives its characteristic morph targets and neutral returns to zero", async () => {
    const r = await makeRobot();
    const expectations: Record<string, [string, string][]> = {
      happy: [["Eye_L", "eyeHappy"], ["Mouth", "mouthSmile"]],
      sad: [["Eye_R", "eyeSad"], ["Brow_L", "browInnerUp"], ["Mouth", "mouthFrown"]],
      surprised: [["Eye_L", "eyeSurprised"], ["Mouth", "mouthSurprise"], ["Brow_R", "browUp"]],
      angry: [["Eye_L", "eyeAngry"], ["Brow_R", "browInnerDown"]],
      curious: [["Eye_L", "eyeCurious"], ["Brow_L", "browUp"]],
      thinking: [["Eye_L", "eyeSquint"], ["Brow_L", "browUp"], ["Brow_R", "browDown"]],
      content: [["Eye_L", "eyeHappy"], ["Eye_R", "eyeHappy"]],
      error: [["Eye_L", "eyeSad"], ["Mouth", "mouthFrown"]],
    };
    for (const e of EMOTIONS) {
      if (e === "neutral" || e === "friendly") continue;
      r.setEmotion(e);
      run(r, 1);
      for (const [mesh, name] of expectations[e]) expect(morph(r, mesh, name), `${e}: ${mesh}.${name}`).toBeGreaterThan(0.3);
    }
    r.setEmotion("neutral");
    run(r, 1.5);
    for (const [mesh, names] of [["Eye_L", ["eyeHappy", "eyeSad", "eyeAngry"]], ["Mouth", ["mouthSmile", "mouthFrown"]]] as const) {
      for (const n of names) expect(morph(r, mesh, n)).toBeLessThan(0.02);
    }
  });

  it("emotion transitions are smooth (no frame-to-frame jump) and intensity scales the result", async () => {
    const r = await makeRobot();
    r.setEmotion("happy", 0.5);
    run(r, 1);
    const half = morph(r, "Mouth", "mouthSmile");
    r.setEmotion("happy", 1);
    let prev = half;
    let maxStep = 0;
    for (let i = 0; i < 60; i++) {
      r.update(1 / 60);
      const v = morph(r, "Mouth", "mouthSmile");
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(prev).toBeGreaterThan(0.95);
    expect(maxStep).toBeLessThan(0.15);
  });

  it("setEyeExpression overrides only the eyes; null returns control to the emotion", async () => {
    const r = await makeRobot();
    r.setEmotion("happy");
    r.setEyeExpression("angry");
    run(r, 1);
    expect(morph(r, "Eye_L", "eyeAngry")).toBeGreaterThan(0.8);
    expect(morph(r, "Eye_L", "eyeHappy")).toBeLessThan(0.05);
    expect(morph(r, "Mouth", "mouthSmile")).toBeGreaterThan(0.8); // mouth untouched
    r.setEyeExpression(null);
    run(r, 1);
    expect(morph(r, "Eye_L", "eyeHappy")).toBeGreaterThan(0.8);
  });

  it("blinks: manual blink closes both eyes and releases; auto blink fires on its own", async () => {
    const r = await makeRobot();
    r.blink();
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      r.update(1 / 60);
      peak = Math.max(peak, morph(r, "Eye_L", "eyeBlink"), morph(r, "Eye_R", "eyeBlink"));
    }
    expect(peak).toBeGreaterThan(0.95);
    expect(morph(r, "Eye_L", "eyeBlink")).toBeLessThan(0.01);

    const a = await makeRobot("premium", { autoBlink: true, rng: () => 0.1 });
    let blinks = 0;
    let prev = 0;
    for (let i = 0; i < 60 * 12; i++) {
      a.update(1 / 60);
      const v = morph(a, "Eye_L", "eyeBlink");
      if (v > 0.9 && prev <= 0.9) blinks++;
      prev = v;
    }
    expect(blinks).toBeGreaterThanOrEqual(2);
  });

  it("setMouthOpen is a real, independent control", async () => {
    const r = await makeRobot();
    r.setMouthOpen(0.5);
    run(r, 0.6);
    expect(morph(r, "Mouth", "mouthOpen")).toBeCloseTo(0.5, 1);
    r.setMouthOpen(1);
    run(r, 0.6);
    expect(morph(r, "Mouth", "mouthOpen")).toBeCloseTo(1, 1);
    r.setMouthOpen(null);
    run(r, 0.6);
    expect(morph(r, "Mouth", "mouthOpen")).toBeLessThan(0.02);
  });

  it("morph influences are always within 0..1", async () => {
    const r = await makeRobot("premium", { autoBlink: true });
    for (const e of EMOTIONS) {
      r.setEmotion(e);
      r.speak({ text: "wow that is amazing news", tts: false, emotion: e });
      run(r, 1.2);
      for (const m of r.parts.meshes.values()) for (const v of m.morphTargetInfluences ?? []) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
