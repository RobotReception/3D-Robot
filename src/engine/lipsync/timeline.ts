import { VISEMES, visemeMorph, type Viseme, type VisemeEvent } from "./visemes";

export type VisemeWeights = Record<string, number>;

/** Sorted viseme events with O(log n) lookup of the active event at a given time. */
export class VisemeTimeline {
  private ev: VisemeEvent[] = [];

  constructor(events: VisemeEvent[] = []) {
    this.add(events);
  }
  add(events: VisemeEvent[]) {
    this.ev.push(...events);
    this.ev.sort((a, b) => a.time - b.time);
  }
  get events() {
    return this.ev;
  }
  get length() {
    return this.ev.length;
  }
  /** end time of the last event */
  get duration() {
    const l = this.ev[this.ev.length - 1];
    if (!l) return 0;
    return l.time + (l.duration ?? 0.1);
  }

  /** the event active at t (null before the first event / after the last one ended) */
  at(t: number): VisemeEvent | null {
    const ev = this.ev;
    if (!ev.length || t < ev[0].time) return null;
    let lo = 0;
    let hi = ev.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ev[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    const e = ev[lo];
    const end = e.duration !== undefined ? e.time + e.duration : (ev[lo + 1]?.time ?? e.time + 0.12);
    return t < end ? e : null;
  }

  /** Morph-target weights for time t (`viseme_xx` keys). `gain` scales articulation. */
  weights(t: number, gain = 1): VisemeWeights {
    const e = this.at(t);
    if (!e || e.viseme === "sil") return {};
    return { [visemeMorph(e.viseme)]: Math.min(1, (e.weight ?? 1) * gain) };
  }
}

export const ALL_VISEME_MORPHS = VISEMES.filter((v) => v !== "sil").map((v) => visemeMorph(v as Viseme));
