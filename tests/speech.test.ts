import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makeRobot, run } from "./helpers/robot";
import { deriveCues } from "../src/engine/SpeechPerformer";
import { textToVisemeEvents, textToUnits } from "../src/engine/lipsync/phonemizer";
import { alignTextToActivity } from "../src/engine/lipsync/align";
import { VisemeTimeline } from "../src/engine/lipsync/timeline";

const TEXT = "Hello, welcome to Al Razi University. How can I help you today? That is wonderful!";

describe("prosody from text", () => {
  it("marks content words with a stressed vowel (nuclear accent last in the phrase), not function words", () => {
    const units = textToUnits("the university is in the city.");
    const accents = units.filter((u) => u.accent !== undefined);
    expect(accents.length).toBe(2); // university, city (the/is/in carry no stress)
    expect(Math.max(...accents.map((u) => u.accent!))).toBe(1); // the last content word of the phrase
    expect(units.filter((u) => u.kind === "pause" && u.mark === ".").length).toBe(1);
  });

  it("keeps the closing punctuation on pauses and on aligned phrase ends", () => {
    const ev = textToVisemeEvents("Are you ready? Yes!");
    expect(ev.filter((e) => e.mark).map((e) => e.mark)).toEqual(["?", "!"]);
    const aligned = alignTextToActivity("Are you ready? Yes!", [{ start: 0, end: 1 }, { start: 1.6, end: 2.2 }]);
    expect(aligned.filter((e) => e.endMark).map((e) => e.endMark)).toEqual(["?", "!"]);
    expect(aligned.some((e) => e.accent)).toBe(true);
  });

  it("deriveCues finds phrase starts, accents and boundaries with their marks; audio-only events get rhythmic accents", () => {
    const cues = deriveCues(textToVisemeEvents(TEXT));
    expect(cues.filter((c) => c.kind === "start").length).toBe(4); // 4 phrases (commas, full stop, ?, !)
    expect(cues.filter((c) => c.kind === "boundary").map((c) => c.mark)).toEqual([",", ".", "?", "!"]);
    expect(cues.filter((c) => c.kind === "accent").length).toBeGreaterThanOrEqual(8);
    const plain = textToVisemeEvents(TEXT).map(({ accent, mark, ...e }) => e);
    const c2 = deriveCues(plain);
    const acc = c2.filter((x) => x.kind === "accent");
    expect(acc.length).toBeGreaterThan(3);
    for (let i = 1; i < acc.length; i++) expect(acc[i].t - acc[i - 1].t).toBeGreaterThanOrEqual(0.44);
  });
});

describe("coarticulated mouth", () => {
  const w = (t: VisemeTimeline, x: number) => Object.values(t.weights(x)).reduce((s, v) => s + v, 0);
  it("does not close between words (short gaps are bridged) but does close at a real pause", () => {
    const ev = [
      { time: 0, viseme: "aa" as const, duration: 0.12 }, { time: 0.12, viseme: "sil" as const, duration: 0.045, weight: 0 },
      { time: 0.165, viseme: "O" as const, duration: 0.12 }, { time: 0.285, viseme: "sil" as const, duration: 0.36, weight: 0 },
      { time: 0.645, viseme: "aa" as const, duration: 0.12 },
    ];
    const tl = new VisemeTimeline(ev);
    expect(w(tl, 0.14)).toBeGreaterThan(0.6); // mid word gap: still open
    expect(w(tl, 0.45)).toBeLessThan(0.05); // mid pause: closed
  });
  it("lip closures win over a neighbouring vowel; soft consonants between vowels barely close the mouth", () => {
    const pp = new VisemeTimeline([{ time: 0, viseme: "aa", duration: 0.1 }, { time: 0.1, viseme: "PP", duration: 0.08 }, { time: 0.18, viseme: "aa", duration: 0.1 }]);
    const wp = pp.weights(0.14);
    expect(wp.viseme_PP).toBeGreaterThan(0.6);
    expect((wp.viseme_aa ?? 0)).toBeLessThan(wp.viseme_PP);
    const dd = new VisemeTimeline([{ time: 0, viseme: "aa", duration: 0.1 }, { time: 0.1, viseme: "DD", duration: 0.06 }, { time: 0.16, viseme: "aa", duration: 0.1 }]);
    const wd = dd.weights(0.13);
    expect(wd.viseme_aa ?? 0).toBeGreaterThan(wd.viseme_DD ?? 0); // the vowel shape persists through the "d"
  });
  it("anticipates: a viseme starts ramping in shortly BEFORE its event", () => {
    const tl = new VisemeTimeline([{ time: 0.5, viseme: "aa", duration: 0.2 }]);
    expect(tl.weights(0.44).viseme_aa ?? 0).toBe(0);
    expect(tl.weights(0.48).viseme_aa ?? 0).toBeGreaterThan(0.3);
  });
});

describe("SpeechPerformer on the robot", () => {
  async function speakRecord(opts: { intensity?: number; text?: string } = {}) {
    const r = await makeRobot("concierge");
    r.performer.intensity = opts.intensity ?? 1;
    run(r, 0.5);
    r.speak({ text: opts.text ?? TEXT, tts: false } as never);
    const rec: { t: number; head: THREE.Quaternion; arm: THREE.Quaternion; brow: number; blink: number }[] = [];
    const eye = r.parts.meshes.get("Eye_L")!, brow = r.parts.meshes.get("Brow_L")!;
    for (let i = 0; i < 60 * 14 && r.speaking; i++) {
      r.update(1 / 60);
      rec.push({
        t: r.lipsync.currentTime, head: r.joints.bone("head").quaternion.clone(), arm: r.joints.bone("forearm_R").quaternion.clone(),
        brow: brow.morphTargetInfluences![brow.morphTargetDictionary!["browUp"]],
        blink: eye.morphTargetInfluences![eye.morphTargetDictionary!["eyeBlink"]],
      });
    }
    return { r, rec };
  }

  it("hand beats peak ON the stressed syllables (within 60 ms) and the arm prepares before them", async () => {
    const a = await speakRecord(), b = await speakRecord({ intensity: 0 });
    const n = Math.min(a.rec.length, b.rec.length);
    const d = Array.from({ length: n }, (_, i) => a.rec[i].arm.angleTo(b.rec[i].arm) * 57.3);
    const strong = a.r.performer.activeCues.filter((c) => c.kind === "accent" && c.strength >= 0.8).map((c) => c.t);
    expect(strong.length).toBeGreaterThanOrEqual(5);
    let aligned = 0;
    for (const ct of strong) {
      // beat peak in a 0.5 s window around the cue
      let best = 0, bt = 0;
      for (let i = 0; i < n; i++) if (Math.abs(a.rec[i].t - ct) < 0.25 && d[i] > best) { best = d[i]; bt = a.rec[i].t; }
      if (best > 1.5 && Math.abs(bt - ct) < 0.06) aligned++;
    }
    expect(aligned).toBeGreaterThanOrEqual(Math.ceil(strong.length * 0.6)); // hand alternation: not every accent moves THIS arm
    // the arm moves before the cue (preparation), not only after
    const ct = strong[1];
    const before = d.find((v, i) => a.rec[i].t > ct - 0.25 && a.rec[i].t < ct - 0.1 && v > 0.3);
    expect(before ?? 0).toBeGreaterThan(0.3);
  });

  it("blinks at phrase pauses, raises the brows for the question, nods on accents; intensity 0 disables all of it", async () => {
    const a = await speakRecord(), off = await speakRecord({ intensity: 0 });
    const blinks = a.rec.filter((r, i) => r.blink > 0.8 && (i === 0 || a.rec[i - 1].blink <= 0.8)).length;
    expect(blinks).toBeGreaterThanOrEqual(3); // 4 pauses, 80 % blink
    expect(Math.max(...a.rec.map((r) => r.brow))).toBeGreaterThan(0.2);
    expect(Math.max(...off.rec.map((r) => r.brow))).toBeLessThan(0.1);
    const n = Math.min(a.rec.length, off.rec.length);
    const headDelta = Math.max(...Array.from({ length: n }, (_, i) => a.rec[i].head.angleTo(off.rec[i].head) * 57.3));
    expect(headDelta).toBeGreaterThan(2);
    expect(Math.max(...off.rec.map((r) => r.blink))).toBe(0); // autoBlink is off in the test robot, performer off -> no blink at all
  });

  it("is smooth: no frame moves the head more than 1 degree or the arm more than 3 degrees, and it stops when the speech ends", async () => {
    const { r, rec } = await speakRecord();
    for (let i = 1; i < rec.length; i++) {
      expect(rec[i].head.angleTo(rec[i - 1].head) * 57.3).toBeLessThan(1);
      expect(rec[i].arm.angleTo(rec[i - 1].arm) * 57.3).toBeLessThan(3);
    }
    run(r, 3);
    expect(r.performer.amount).toBeLessThan(0.01);
    expect(r.performer.activeCues.length).toBe(0);
  });

  it("speak({ gestures:false }) keeps nods but no hand beats", async () => {
    const r = await makeRobot("concierge");
    run(r, 0.5);
    r.speak({ text: TEXT, tts: false, gestures: false } as never);
    const arm0 = r.joints.bone("forearm_R").quaternion.clone();
    let maxArm = 0;
    for (let i = 0; i < 60 * 8 && r.speaking; i++) { r.update(1 / 60); maxArm = Math.max(maxArm, r.joints.bone("forearm_R").quaternion.angleTo(arm0) * 57.3); }
    expect(maxArm).toBeLessThan(4); // only idle breathing; the talk poses and beats are off
  });
});
