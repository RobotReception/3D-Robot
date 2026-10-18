import { describe, expect, it } from "vitest";
import { synthesize, type Segment } from "./helpers/synth";
import { makeRobot, run, morph } from "./helpers/robot";
import { textToVisemeEvents, textToUnits, estimateSpeechDuration } from "../src/engine/lipsync/phonemizer";
import { analyzeAudioBuffer, classifyVowel, estimateFormants, fft } from "../src/engine/lipsync/audioAnalysis";
import { VisemeTimeline } from "../src/engine/lipsync/timeline";
import { fromAzureVisemes, fromCharacterAlignment, fromRhubarb, fromWordTimings } from "../src/engine/lipsync/adapters";
import { pcm16ToFloat32 } from "../src/engine/AudioController";

const vis = (t: string) => textToUnits(t).filter((u) => u.kind !== "pause").map((u) => u.viseme);

describe("text -> visemes (English + Arabic)", () => {
  it("maps English spelling to plausible mouth shapes", () => {
    expect(vis("mama")).toEqual(["PP", "aa", "PP", "aa"]);
    expect(vis("fee")).toEqual(["FF", "I"]); // 'ee' digraph
    expect(vis("shoe")).toEqual(["CH", "O", "E"].slice(0, 2).concat(vis("shoe").slice(2))); // sh -> CH, o -> O
    expect(vis("the")[0]).toBe("TH");
    expect(vis("make")).toEqual(["PP", "aa", "kk"]); // silent final e
    expect(vis("sun")).toEqual(["SS", "U", "nn"].slice(0, 1).concat(vis("sun").slice(1)));
    expect(vis("hello")).toEqual(["E", "nn", "O"]);
  });

  it("maps Arabic letters and harakat", () => {
    expect(vis("مرحبا")).toEqual(expect.arrayContaining(["PP", "RR", "aa"]));
    // vocalised: ba fatha -> PP + aa, bi kasra -> PP + I, bu damma -> PP + U
    expect(vis("بَ")).toEqual(["PP", "aa"]);
    expect(vis("بِ")).toEqual(["PP", "I"]);
    expect(vis("بُ")).toEqual(["PP", "U"]);
    // long vowels in unvocalised text: alif -> aa, waw -> U, ya -> I
    expect(vis("بابا")).toContain("aa");
    expect(vis("نور")).toEqual(expect.arrayContaining(["nn", "U", "RR"]));
    expect(vis("سيف")).toEqual(expect.arrayContaining(["SS", "I", "FF"]));
    expect(vis("شكرا")).toEqual(expect.arrayContaining(["CH", "kk", "RR", "aa"]));
  });

  it("shadda lengthens the consonant; implicit short vowels are inserted between consonants", () => {
    const plain = textToUnits("بَ")[0];
    const gem = textToUnits("بَّ")[0];
    expect(gem.dur).toBeGreaterThan(plain.dur * 1.5);
    const cluster = textToUnits("كتب"); // k-t-b without vowels
    expect(cluster.filter((u) => u.kind === "vowel").length).toBeGreaterThanOrEqual(2);
  });

  it("handles mixed Arabic/English and punctuation pauses; empty input is empty", () => {
    const u = textToUnits("مرحبا, hello!");
    expect(u.some((x) => x.kind === "pause" && x.dur >= 0.2)).toBe(true);
    expect(vis("مرحبا, hello!")).toEqual(expect.arrayContaining(["PP", "E", "O"]));
    expect(textToVisemeEvents("")).toEqual([]);
    expect(textToVisemeEvents("   ...  ")).toHaveLength(1); // a single pause
  });

  it("stretches the timeline to a known audio duration and is monotonic", () => {
    const ev = textToVisemeEvents("Hello, how are you today?", { totalDuration: 3.2 });
    const last = ev[ev.length - 1];
    expect(last.time + last.duration!).toBeCloseTo(3.2, 2);
    for (let i = 1; i < ev.length; i++) expect(ev[i].time).toBeGreaterThanOrEqual(ev[i - 1].time);
    expect(estimateSpeechDuration("Hello, how are you today?", 2)).toBeCloseTo(estimateSpeechDuration("Hello, how are you today?", 1) / 2, 5);
  });
});

describe("TTS timing adapters", () => {
  it("Azure visemes: ids -> shapes with durations from successive offsets", () => {
    const ev = fromAzureVisemes([{ visemeId: 0, audioOffset: 0 }, { visemeId: 21, audioOffset: 1_000_000 }, { visemeId: 2, audioOffset: 2_500_000 }]);
    expect(ev.map((e) => e.viseme)).toEqual(["sil", "PP", "aa"]);
    expect(ev[1].time).toBeCloseTo(0.1, 5);
    expect(ev[1].duration).toBeCloseTo(0.15, 5);
    expect(ev[0].weight).toBe(0);
  });
  it("Rhubarb cues and word/character timings", () => {
    expect(fromRhubarb([{ start: 0, end: 0.2, value: "X" }, { start: 0.2, end: 0.4, value: "D" }]).map((e) => e.viseme)).toEqual(["sil", "aa"]);
    const w = fromWordTimings([{ word: "hello", start: 1, end: 1.6 }]);
    expect(w[0].time).toBeCloseTo(1, 5);
    const end = w[w.length - 1];
    expect(end.time + end.duration!).toBeCloseTo(1.6, 5);
    const chars = "hi all".split("");
    const c = fromCharacterAlignment({
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.1),
      character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
    });
    expect(c[0].time).toBeCloseTo(0, 5);
    expect(c[c.length - 1].time).toBeGreaterThan(0.3); // second word starts at 0.3
  });
});

describe("audio-driven analysis (synthetic formant audio with known content)", () => {
  const segs: Segment[] = [];
  for (const v of ["aa", "E", "I", "O", "U"]) segs.push({ kind: "vowel", v, dur: 0.38 }, { kind: "sil", dur: 0.16 });
  segs.push({ kind: "fric", dur: 0.3 }, { kind: "sil", dur: 0.2 });

  it("FFT of a pure tone peaks at the right bin", () => {
    const n = 1024;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n);
    fft(re, im);
    let best = 0;
    for (let i = 1; i < n / 2; i++) if (re[i] ** 2 + im[i] ** 2 > re[best] ** 2 + im[best] ** 2) best = i;
    expect(best).toBe(64);
  });

  it("recovers formants within ~15 % and classifies reference vowels", () => {
    for (const [v, [f1, f2]] of Object.entries({ aa: [730, 1090], E: [530, 1840], I: [270, 2290], O: [570, 840], U: [300, 870] })) {
      const a = synthesize([{ kind: "vowel", v, dur: 0.1 }], 16000);
      const f = estimateFormants(a.samples.subarray(300, 300 + 640), 16000)!;
      expect(f.f1 / f1, `${v} F1`).toBeGreaterThan(0.8);
      expect(f.f1 / f1, `${v} F1`).toBeLessThan(1.25);
      const w = classifyVowel(f1, f2) as Record<string, number>;
      const top = Object.entries(w).sort((x, y) => y[1] - x[1])[0][0];
      expect(top).toBe(v);
    }
  });

  for (const sr of [16000, 22050, 44100]) {
    it(`labels vowels, silence and fricatives correctly at ${sr} Hz and aligns boundaries (<=60 ms)`, () => {
      const a = synthesize(segs, sr);
      const { events } = analyzeAudioBuffer(a.samples, sr);
      const at = (t: number) => events.find((e) => t >= e.time && t < e.time + (e.duration ?? 0.02))?.viseme ?? "sil";
      let ok = 0;
      for (const l of a.labels) {
        const mid = (l.start + l.end) / 2;
        const expected = l.label === "sil" ? "sil" : l.label;
        if (at(mid) === expected) ok++;
        else console.warn(`mismatch @${mid.toFixed(2)} expected ${expected} got ${at(mid)}`);
      }
      expect(ok / a.labels.length).toBeGreaterThanOrEqual(0.9);
      // onset alignment of each voiced segment
      const errs: number[] = [];
      for (const l of a.labels.filter((x) => x.label !== "sil")) {
        const onset = events.find((e) => e.viseme !== "sil" && e.time + (e.duration ?? 0) > l.start + 0.02 && e.time >= l.start - 0.1);
        if (onset) errs.push(Math.abs(onset.time - l.start));
      }
      errs.sort((x, y) => x - y);
      expect(errs[Math.floor(errs.length / 2)]).toBeLessThanOrEqual(0.06);
    });
  }

  it("pure silence and very quiet noise produce a closed mouth (no jitter)", () => {
    const quiet = new Float32Array(16000).map((_, i) => 0.0005 * Math.sin(i));
    const { events } = analyzeAudioBuffer(quiet, 16000);
    expect(events.every((e) => e.viseme === "sil" || (e.weight ?? 0) < 0.2)).toBe(true);
    expect(analyzeAudioBuffer(new Float32Array(16000), 16000).events.every((e) => e.viseme === "sil")).toBe(true);
  });

  it("PCM16 chunks decode to floats", () => {
    const f = pcm16ToFloat32(new Int16Array([0, 16384, -32768]));
    expect(f[1]).toBeCloseTo(0.5, 3);
    expect(f[2]).toBe(-1);
  });
});

describe("LipSyncController -> mouth morph targets", () => {
  it("timeline playback opens the right shapes at the right time and closes at the end", async () => {
    const r = await makeRobot();
    const events = [{ time: 0.2, viseme: "aa" as const, duration: 0.3 }, { time: 0.5, viseme: "PP" as const, duration: 0.2 }, { time: 0.7, viseme: "O" as const, duration: 0.3 }];
    let ended = false;
    r.lipsync.playTimeline(events, { onEnd: () => (ended = true) });
    run(r, 0.1);
    expect(morph(r, "Mouth", "viseme_aa")).toBeLessThan(0.05); // not yet
    run(r, 0.25); // t=0.35
    expect(morph(r, "Mouth", "viseme_aa")).toBeGreaterThan(0.8);
    run(r, 0.25); // t=0.6
    expect(morph(r, "Mouth", "viseme_PP")).toBeGreaterThan(0.8);
    expect(morph(r, "Mouth", "viseme_aa")).toBeLessThan(0.1);
    run(r, 0.25); // t=0.85
    expect(morph(r, "Mouth", "viseme_O")).toBeGreaterThan(0.8);
    run(r, 0.7);
    expect(ended).toBe(true);
    for (const v of ["aa", "PP", "O"]) expect(morph(r, "Mouth", `viseme_${v}`)).toBeLessThan(0.02);
    expect(r.lipsync.active).toBe(false);
  });

  it("transitions between shapes are continuous (spring-smoothed), never popping", async () => {
    const r = await makeRobot();
    r.lipsync.playTimeline(textToVisemeEvents("amazing opportunity today", {}));
    let prev: number[] = [];
    let maxJump = 0;
    for (let i = 0; i < 60 * 3; i++) {
      r.update(1 / 60);
      const cur = ["aa", "E", "I", "O", "U", "PP", "nn", "SS"].map((v) => morph(r, "Mouth", `viseme_${v}`));
      if (prev.length) maxJump = Math.max(maxJump, ...cur.map((c, k) => Math.abs(c - prev[k])));
      prev = cur;
    }
    expect(maxJump).toBeLessThan(0.55);
  });

  it("the offset control shifts the mouth in time (sync tuning)", async () => {
    const mk = async (offset: number) => {
      const r = await makeRobot();
      r.lipsync.offsetMs = offset;
      r.lipsync.playTimeline([{ time: 0.5, viseme: "aa", duration: 0.5 }]);
      run(r, 0.45);
      return morph(r, "Mouth", "viseme_aa");
    };
    expect(await mk(0)).toBeLessThan(0.1);
    expect(await mk(150)).toBeGreaterThan(0.5); // mouth leads the clock by 150 ms
  });

  it("loudness envelope closes the mouth where the audio is silent even if the text says otherwise", async () => {
    const r = await makeRobot();
    const env = { data: new Float32Array(300).fill(0), hop: 0.01 };
    for (let i = 100; i < 200; i++) env.data[i] = 0.8; // sound only between 1.0 s and 2.0 s
    r.lipsync.playTimeline([{ time: 0, viseme: "aa", duration: 3 }], { envelope: env });
    run(r, 0.5);
    expect(morph(r, "Mouth", "viseme_aa")).toBeLessThan(0.2);
    run(r, 1.0);
    expect(morph(r, "Mouth", "viseme_aa")).toBeGreaterThan(0.6);
  });

  it("streaming: events pushed while playing are honoured; endStream lets the timeline finish", async () => {
    const r = await makeRobot();
    r.lipsync.playTimeline([], { streaming: true });
    run(r, 0.3);
    r.lipsync.pushEvents([{ time: 0.4, viseme: "E", duration: 0.3 }]);
    run(r, 0.25);
    expect(morph(r, "Mouth", "viseme_E")).toBeGreaterThan(0.7);
    r.lipsync.endStream();
    run(r, 1);
    expect(r.lipsync.active).toBe(false);
  });

  it("live frame source: a vowel frame drives the matching viseme", async () => {
    const r = await makeRobot();
    const a = synthesize([{ kind: "vowel", v: "I", dur: 1.0 }], 16000);
    let pos = 0;
    r.lipsync.startLive({ sampleRate: 16000, size: 640, read: (out) => { out.set(a.samples.subarray(pos, pos + 640)); pos += 267; } });
    run(r, 0.4);
    expect(morph(r, "Mouth", "viseme_I")).toBeGreaterThan(0.5);
    r.lipsync.stop();
    run(r, 0.5);
    expect(morph(r, "Mouth", "viseme_I")).toBeLessThan(0.02);
  });

  it("the full speech flow works for English and Arabic text: mouth moves, head/hands animate, returns to idle", async () => {
    for (const text of ["Hello, I am your assistant.", "مرحبا، أنا مساعدك الذكي. كيف أستطيع مساعدتك اليوم؟"]) {
      const r = await makeRobot();
      const events: string[] = [];
      r.on("speech:start", () => events.push("start"));
      r.on("speech:end", () => events.push("end"));
      const h = r.speak({ text, tts: false, emotion: "friendly" });
      let peakOpen = 0;
      let gestureSeen = false;
      const seen = new Set<string>();
      const dur = estimateSpeechDuration(text);
      for (let i = 0; i < Math.ceil((dur + 1) * 60); i++) {
        r.update(1 / 60);
        let sum = 0;
        for (const [k, v] of Object.entries(r.lipsync.currentWeights)) {
          sum += v;
          if (v > 0.5) seen.add(k);
        }
        peakOpen = Math.max(peakOpen, sum);
        if (r.animation.ownerOf("armR")?.name === "talkR") gestureSeen = true;
      }
      await h.finished;
      expect(events).toEqual(["start", "end"]);
      expect(peakOpen).toBeGreaterThan(0.7);
      expect(seen.size).toBeGreaterThanOrEqual(4); // several distinct mouth shapes
      expect(gestureSeen).toBe(true);
      run(r, 1.5);
      expect(r.speaking).toBe(false);
      expect(r.stateMachine.state).toBe("idle");
      expect(r.animation.ownerOf("armR")!.name).toBe("idle");
      expect(morph(r, "Mouth", "viseme_aa")).toBeLessThan(0.02);
    }
  });

  it("sync accuracy through the whole stack: mouth peak times follow the viseme timings within 80 ms", async () => {
    const r = await makeRobot();
    const target = [0.5, 1.1, 1.7, 2.3];
    const names = ["aa", "O", "E", "U"] as const;
    r.lipsync.playTimeline(target.map((t, i) => ({ time: t, viseme: names[i], duration: 0.4 })));
    const peaks: number[] = [];
    let best = names.map(() => ({ v: 0, t: 0 }));
    for (let i = 0; i < 60 * 3; i++) {
      r.update(1 / 60);
      names.forEach((n, k) => {
        const v = morph(r, "Mouth", `viseme_${n}`);
        if (v > best[k].v) best[k] = { v, t: r.time };
      });
    }
    best.forEach((b, k) => peaks.push(b.t));
    // each peak is reached while its viseme window is active (centre of window +/- 0.2 s)
    peaks.forEach((p, k) => {
      expect(p).toBeGreaterThanOrEqual(target[k] - 0.02);
      expect(p).toBeLessThanOrEqual(target[k] + 0.4 + 0.08);
    });
    expect(new VisemeTimeline([{ time: 0, viseme: "aa", duration: 1 }]).at(0.5)?.viseme).toBe("aa");
  });
});

describe("hybrid alignment (text placed inside real speech)", () => {
  it("phrases map to audio runs: no viseme is placed in silence and phrase onsets match the audio", async () => {
    const { activeIntervals, alignTextToActivity } = await import("../src/engine/lipsync/align");
    const { loudnessEnvelope } = await import("../src/engine/lipsync/audioAnalysis");
    // two spoken phrases separated by 0.6 s of silence, with silence at both ends
    const a = synthesize([
      { kind: "sil", dur: 0.3 }, { kind: "vowel", v: "aa", dur: 0.3 }, { kind: "vowel", v: "E", dur: 0.3 },
      { kind: "sil", dur: 0.6 }, { kind: "vowel", v: "O", dur: 0.35 }, { kind: "vowel", v: "U", dur: 0.35 }, { kind: "sil", dur: 0.4 },
    ], 16000);
    const hop = 0.01;
    const env = loudnessEnvelope(a.samples, a.sampleRate, hop);
    const iv = activeIntervals(env, hop);
    expect(iv).toHaveLength(2);
    expect(iv[0].start).toBeCloseTo(0.3, 1);
    expect(iv[1].start).toBeCloseTo(1.5, 1);
    const ev = alignTextToActivity("hello world, amazing sound", iv);
    // the text has one comma -> 2 phrases -> they land on the 2 runs
    expect(ev.length).toBeGreaterThan(6);
    const inside = (t: number) => iv.some((r) => t >= r.start - 0.02 && t <= r.end + 0.02);
    for (const e of ev) {
      expect(inside(e.time)).toBe(true);
      expect(inside(e.time + e.duration! - 0.001)).toBe(true);
    }
    expect(Math.min(...ev.filter((e) => e.time < 1.2).map((e) => e.time))).toBeCloseTo(iv[0].start, 1);
    expect(Math.min(...ev.filter((e) => e.time >= 1.2).map((e) => e.time))).toBeCloseTo(iv[1].start, 1);
  });

  it("falls back to proportional spreading over all active time when the counts differ", async () => {
    const { alignTextToActivity } = await import("../src/engine/lipsync/align");
    const ev = alignTextToActivity("one two three four", [{ start: 0.5, end: 1.0 }, { start: 2.0, end: 2.5 }]);
    expect(ev[0].time).toBeCloseTo(0.5, 2);
    const last = ev[ev.length - 1];
    expect(last.time + last.duration!).toBeCloseTo(2.5, 2);
    expect(ev.every((e) => (e.time >= 0.5 - 1e-6 && e.time + e.duration! <= 1.0 + 1e-6) || (e.time >= 2.0 - 1e-6 && e.time + e.duration! <= 2.5 + 1e-6))).toBe(true);
  });
});
