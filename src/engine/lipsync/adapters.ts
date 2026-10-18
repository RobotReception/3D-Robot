import { AZURE_VISEME_MAP, RHUBARB_MAP, type VisemeEvent } from "./visemes";
import { textToUnits } from "./phonemizer";

/** Azure Speech `VisemeReceived` events. `audioOffset` is in 100-ns ticks (Azure SDK) or use `offsetMs`. */
export function fromAzureVisemes(
  events: { visemeId: number; audioOffset?: number; offsetMs?: number }[],
): VisemeEvent[] {
  const list = events
    .map((e) => ({ id: e.visemeId, t: e.offsetMs !== undefined ? e.offsetMs / 1000 : (e.audioOffset ?? 0) / 1e7 }))
    .sort((a, b) => a.t - b.t);
  return list.map((e, i) => ({
    time: e.t,
    viseme: AZURE_VISEME_MAP[e.id] ?? "sil",
    duration: i + 1 < list.length ? list[i + 1].t - e.t : 0.12,
    weight: e.id === 0 ? 0 : 1,
  }));
}

/** Rhubarb Lip Sync JSON `mouthCues`: [{start,end,value}] */
export function fromRhubarb(cues: { start: number; end: number; value: string }[]): VisemeEvent[] {
  return cues.map((c) => ({
    time: c.start, duration: c.end - c.start, viseme: RHUBARB_MAP[c.value] ?? "sil", weight: c.value === "X" ? 0 : 1,
  }));
}

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/** Distribute each word's phoneme units across its real [start,end] window (word-level forced alignment). */
export function fromWordTimings(words: WordTiming[]): VisemeEvent[] {
  const out: VisemeEvent[] = [];
  for (const w of words) {
    const units = textToUnits(w.word).filter((u) => u.kind !== "pause");
    const total = units.reduce((s, u) => s + u.dur, 0);
    if (!units.length || total <= 0) continue;
    const span = Math.max(0.02, w.end - w.start);
    let t = w.start;
    for (const u of units) {
      const d = (u.dur / total) * span;
      out.push({ time: t, viseme: u.viseme, duration: d, weight: u.weight });
      t += d;
    }
  }
  return out;
}

/**
 * ElevenLabs-style character alignment:
 * { characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }
 * Characters are grouped into words by whitespace, then handled like word timings.
 */
export function fromCharacterAlignment(a: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): VisemeEvent[] {
  const words: WordTiming[] = [];
  let cur = "";
  let start = 0;
  let end = 0;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push({ word: cur, start, end });
      cur = "";
    } else {
      if (!cur) start = a.character_start_times_seconds[i];
      cur += ch;
      end = a.character_end_times_seconds[i];
    }
  });
  if (cur) words.push({ word: cur, start, end });
  return fromWordTimings(words);
}
