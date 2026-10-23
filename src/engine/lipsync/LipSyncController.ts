import type { FaceController } from "../FaceController";
import { MIN_REF_RMS, classifyFrame, frameFeatures } from "./audioAnalysis";
import { VisemeTimeline } from "./timeline";
import { visemeMorph, type Viseme, type VisemeEvent } from "./visemes";

export interface PlayTimelineOptions {
  /** returns the current playback time in seconds (e.g. from an AudioContext); default: internal clock */
  clock?: () => number;
  /** loudness envelope (0..1) used to close the mouth in real silences (hybrid mode) */
  envelope?: { data: Float32Array; hop: number };
  /** keep the timeline open for more `pushEvents` (streaming) until `endStream()` */
  streaming?: boolean;
  onEnd?: () => void;
}

/** Source of raw audio frames for live (stream / microphone / media element) analysis. */
export interface LiveFrameSource {
  sampleRate: number;
  /** fill `out` with the latest time-domain samples (-1..1) */
  read(out: Float32Array): void;
  size: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * Turns timelines (text/TTS visemes) or live audio into viseme weights and pushes them
 * to the FaceController. Three input paths, all producing the same output:
 *   1. playTimeline  - viseme events + (optional) audio clock + (optional) loudness envelope
 *   2. startLive     - analyse an audio stream frame by frame (no text needed)
 *   3. pushEvents    - append events while streaming TTS
 */
export class LipSyncController {
  /** articulation multiplier */
  gain = 1;
  /** shift visemes relative to audio (+ = mouth later), milliseconds. Tune for TTS/network latency. */
  offsetMs = 0;
  /** extra seconds to look ahead on top of the built-in anticipation (every viseme already ramps in ~50 ms before its
   *  event, as mouths lead sound in real speech; see VisemeTimeline.weights) */
  lookahead = 0;
  /** 0 = ignore loudness, 1 = fully gate visemes by loudness in hybrid mode */
  hybrid = 0.85;

  private timeline: VisemeTimeline | null = null;
  private clock: (() => number) | null = null;
  private t = 0;
  private envelope: PlayTimelineOptions["envelope"] | null = null;
  private streaming = false;
  private onEnd?: () => void;
  private live: LiveFrameSource | null = null;
  private liveBuf = new Float32Array(0);
  private liveRef = MIN_REF_RMS;
  private _energy = 0;
  private lastWeights: Record<string, number> = {};
  /** most recent time used for sampling (seconds) */
  currentTime = 0;

  constructor(private face: FaceController) {}

  get active() {
    return !!this.timeline || !!this.live;
  }
  /** smoothed 0..1 mouth activity, used to drive head/hand micro-motion while speaking */
  get energy() {
    return this._energy;
  }
  get currentWeights() {
    return this.lastWeights;
  }
  /** the timeline currently playing (for visualisation) */
  get events(): VisemeEvent[] {
    return this.timeline?.events ?? [];
  }
  get timelineDuration() {
    return this.timeline?.duration ?? 0;
  }

  playTimeline(events: VisemeEvent[], o: PlayTimelineOptions = {}) {
    this.stop();
    this.timeline = new VisemeTimeline(events);
    this.clock = o.clock ?? null;
    this.envelope = o.envelope ?? null;
    this.streaming = !!o.streaming;
    this.onEnd = o.onEnd;
    this.t = 0;
    this.face.setSpeaking(true);
  }
  /** Append events (times relative to the start of the stream). */
  pushEvents(events: VisemeEvent[]) {
    if (!this.timeline) this.playTimeline([], { streaming: true });
    this.timeline!.add(events);
  }
  endStream() {
    this.streaming = false;
  }
  startLive(src: LiveFrameSource) {
    this.stop();
    this.live = src;
    this.liveBuf = new Float32Array(src.size);
    this.face.setSpeaking(true);
  }

  stop() {
    const had = this.active;
    this.timeline = null;
    this.live = null;
    this.clock = null;
    this.envelope = null;
    this.streaming = false;
    this.lastWeights = {};
    this.face.setVisemes({});
    this.face.setSpeaking(false);
    this._energy = 0;
    const cb = this.onEnd;
    this.onEnd = undefined;
    if (had && cb) cb();
  }

  update(dt: number) {
    let weights: Record<string, number> = {};
    if (this.timeline) {
      this.t += dt;
      const now = (this.clock ? this.clock() : this.t) + this.offsetMs / 1000;
      this.currentTime = now;
      weights = this.timeline.weights(now + this.lookahead, this.gain);
      if (this.envelope && this.hybrid > 0) {
        const idx = Math.floor(Math.max(0, now) / this.envelope.hop);
        const lvl = this.envelope.data[Math.min(idx, this.envelope.data.length - 1)] ?? 0;
        const gate = smoothstep(0.03, 0.16, lvl);
        const k = 1 - this.hybrid + this.hybrid * gate;
        for (const key of Object.keys(weights)) weights[key] *= k;
      }
      if (!this.streaming && now > this.timeline.duration + 0.12) {
        const cb = this.onEnd;
        this.onEnd = undefined;
        this.stop();
        cb?.();
        return;
      }
    } else if (this.live) {
      this.live.read(this.liveBuf);
      const f = frameFeatures(this.liveBuf, this.live.sampleRate);
      // adaptive reference level (fast attack, slow release)
      this.liveRef = Math.max(f.rms, this.liveRef * Math.exp(-dt / 4), MIN_REF_RMS);
      const c = classifyFrame(f, this.liveRef);
      const amp = Math.min(1, 0.35 + 0.65 * c.level);
      for (const [v, w] of Object.entries(c.weights) as [Viseme, number][]) {
        if (v !== "sil") weights[visemeMorph(v)] = w * amp * this.gain;
      }
    }
    // keep sum of viseme weights <= 1
    let sum = 0;
    for (const v of Object.values(weights)) sum += v;
    if (sum > 1) for (const k of Object.keys(weights)) weights[k] /= sum;
    this.lastWeights = weights;
    this.face.setVisemes(weights);
    this._energy += (Math.min(1, sum) - this._energy) * (1 - Math.exp(-dt / 0.08));
  }
}
