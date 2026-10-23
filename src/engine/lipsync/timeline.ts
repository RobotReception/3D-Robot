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

  /**
   * Morph-target weights for time t (`viseme_xx` keys). `gain` scales articulation.
   *
   * Coarticulated, like a real mouth (Cohen-Massaro dominance model): every event ramps in `ATTACK` seconds BEFORE it
   * starts and out `RELEASE` seconds after it ends, neighbours overlap and blend by dominance instead of snapping.
   * Vowels dominate over soft consonants (so "n", "d", "k" between vowels do not close the mouth), lip closures
   * (p b m) and teeth contacts (f v) dominate fully (the closure stays visible). Short gaps between words
   * (< 0.1 s) are bridged: the mouth does not flap shut between words, only at real phrase pauses.
   */
  weights(t: number, gain = 1): VisemeWeights {
    const ev = this.ev;
    if (!ev.length) return {};
    // last event that may already be ramping in at t
    let lo = 0, hi = ev.length - 1;
    const ahead = t + ATTACK;
    if (ahead < ev[0].time) return {};
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ev[mid].time <= ahead) lo = mid;
      else hi = mid - 1;
    }
    const out: VisemeWeights = {};
    let dom = 0;
    const floor = t - this.maxDur - RELEASE;
    for (let i = lo; i >= 0 && ev[i].time >= floor; i--) {
      const e = ev[i];
      if (e.viseme === "sil") continue;
      const dur = e.duration ?? (ev[i + 1] ? Math.max(0.02, ev[i + 1].time - e.time) : 0.12);
      const start = e.time, end = e.time + dur;
      // bridge a short word gap: the event keeps its shape through the gap up to the next speech event
      let tail = PAUSE_RELEASE; // into a real pause the mouth closes promptly (right after the sound ends)
      const nx = this.nextSpeech(i);
      if (nx && nx.time - end < GAP_BRIDGE) tail = Math.max(RELEASE, nx.time - end + ATTACK * 0.5); // into the next sound: blend
      const attack = Math.min(ATTACK, dur * 0.8);
      let env: number;
      if (t < start - attack) continue;
      if (t < start) env = smooth((t - (start - attack)) / attack);
      else if (t <= end) env = 1;
      else if (t < end + tail) env = 1 - smooth((t - end) / tail);
      else continue;
      const w = Math.min(1, (e.weight ?? 1) * gain);
      const d = DOMINANCE[e.viseme] * env;
      const key = visemeMorph(e.viseme);
      out[key] = (out[key] ?? 0) + w * d;
      dom += d;
    }
    // rest (closed mouth) fills what the visemes do not: weights are normalised only when over-full
    const norm = Math.max(1, dom);
    for (const k of Object.keys(out)) out[k] = Math.min(1, out[k] / norm);
    return out;
  }

  private nextSpeech(i: number): VisemeEvent | null {
    for (let j = i + 1; j < this.ev.length && j <= i + 3; j++) if (this.ev[j].viseme !== "sil") return this.ev[j];
    return null;
  }
  private get maxDur() {
    if (this._maxDurN !== this.ev.length) {
      this._maxDur = this.ev.reduce((m, e) => Math.max(m, e.duration ?? 0.12), 0.12);
      this._maxDurN = this.ev.length;
    }
    return this._maxDur;
  }
  private _maxDur = 0.12;
  private _maxDurN = -1;
}

const ATTACK = 0.05; // s a shape starts before its event (anticipation)
const RELEASE = 0.06; // blend into a following sound
const PAUSE_RELEASE = 0.03; // close after the last sound before a pause
const GAP_BRIDGE = 0.1; // word gaps shorter than this keep the mouth shape
const smooth = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
/** how strongly a viseme wins where events overlap */
const DOMINANCE: Record<Viseme, number> = {
  sil: 0, PP: 1.7, FF: 1.4, TH: 0.9, DD: 0.55, kk: 0.5, CH: 0.8, SS: 0.7, nn: 0.5, RR: 0.75,
  aa: 1, E: 1, I: 1, O: 1, U: 1,
};

export const ALL_VISEME_MORPHS = VISEMES.filter((v) => v !== "sil").map((v) => visemeMorph(v as Viseme));
