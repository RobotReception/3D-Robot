import { textToUnits, type Unit } from "./phonemizer";
import type { VisemeEvent } from "./visemes";

export interface Interval {
  start: number;
  end: number;
}

/** Speech-activity intervals from a loudness envelope (0..1, `hop` seconds per sample). */
export function activeIntervals(env: Float32Array, hop: number, o: { threshold?: number; minGap?: number; minLen?: number } = {}): Interval[] {
  const thr = o.threshold ?? 0.05;
  const minGap = o.minGap ?? 0.09;
  const minLen = o.minLen ?? 0.05;
  const raw: Interval[] = [];
  let start = -1;
  for (let i = 0; i <= env.length; i++) {
    const on = i < env.length && env[i] > thr;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      raw.push({ start: start * hop, end: i * hop });
      start = -1;
    }
  }
  const merged: Interval[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.start - last.end < minGap) last.end = iv.end;
    else merged.push({ ...iv });
  }
  return merged.filter((iv) => iv.end - iv.start >= minLen);
}

/**
 * Hybrid alignment: place the text's viseme units inside the audio's *actual speech*.
 *  1. split text into phrases at long pauses (comma, full stop...) and the audio into runs at silences;
 *  2. if both have the same count, phrase i is spread over run i; otherwise all units are spread
 *     proportionally over the concatenated active time;
 *  3. silences get no events (mouth closed).
 * Still an approximation (units are spread by nominal length, not recognised phonemes), but
 * onsets/offsets of every phrase now match the audio.
 */
export function alignTextToActivity(text: string, intervals: Interval[], pauseSplit = 0.18): VisemeEvent[] {
  const units = textToUnits(text);
  const phrases: Unit[][] = [[]];
  for (const u of units) {
    if (u.kind === "pause") {
      if (u.dur >= pauseSplit && phrases[phrases.length - 1].length) phrases.push([]);
      continue;
    }
    phrases[phrases.length - 1].push(u);
  }
  const ph = phrases.filter((p) => p.length);
  if (!ph.length || !intervals.length) return [];
  const out: VisemeEvent[] = [];
  const spread = (list: Unit[], ivs: Interval[]) => {
    const total = list.reduce((s, u) => s + u.dur, 0);
    const active = ivs.reduce((s, iv) => s + (iv.end - iv.start), 0);
    let consumed = 0; // in active-time seconds
    for (const u of list) {
      const a = (consumed / total) * active;
      const b = ((consumed + u.dur) / total) * active;
      // map active-time [a,b] to real time across the intervals (an event may straddle a gap: split)
      let acc = 0;
      for (const iv of ivs) {
        const len = iv.end - iv.start;
        const lo = Math.max(a, acc);
        const hi = Math.min(b, acc + len);
        if (hi > lo) out.push({ time: iv.start + (lo - acc), duration: hi - lo, viseme: u.viseme, weight: u.weight });
        acc += len;
      }
      consumed += u.dur;
    }
  };
  if (ph.length === intervals.length) ph.forEach((p, i) => spread(p, [intervals[i]]));
  else spread(ph.flat(), intervals);
  return out.sort((x, y) => x.time - y.time);
}
