import { VISEME_OPENNESS, type Viseme, type VisemeEvent } from "./visemes";

/**
 * Audio-driven lip sync: classify short audio frames into visemes using
 *   - energy gate (silence -> mouth closed),
 *   - high-band dominance (fricatives s/sh/f -> SS / CH),
 *   - LPC formants F1/F2 (voiced frames -> aa / E / I / O / U).
 *
 * Honest limits: this recognises *vowel-like shapes and openness*, not phonemes.
 * Plosives show up only as closures/dips. For letter-accurate sync use the
 * text/viseme path (phonemizer.ts / adapters.ts) - or combine both (hybrid).
 */

// ------------------------------------------------------------------ FFT
const twiddleCache = new Map<number, { cos: Float32Array; sin: Float32Array }>();
function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float32Array(n / 2);
    const sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

/** In-place radix-2 FFT. n must be a power of two. */
export function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const wr = cos[j * step];
        const wi = sin[j * step];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

function hann(n: number) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
const hannCache = new Map<number, Float32Array>();
const getHann = (n: number) => {
  let h = hannCache.get(n);
  if (!h) hannCache.set(n, (h = hann(n)));
  return h;
};

// ------------------------------------------------------------------ LPC formants
function lpcCoefficients(x: Float32Array, order: number): Float64Array | null {
  const n = x.length;
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let i = 0; i < n - k; i++) s += x[i] * x[i + k];
    r[k] = s;
  }
  if (r[0] < 1e-12) return null;
  r[0] *= 1.0001; // white-noise correction for stability
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  const tmp = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) return null;
  }
  return a;
}

/** Spectral-envelope peaks (Hz) from LPC, strongest-first within each of the F1/F2 search ranges. */
export function estimateFormants(frame: Float32Array, sampleRate: number): { f1: number; f2: number } | null {
  // decimate to ~11 kHz with a boxcar low-pass
  const dec = Math.max(1, Math.round(sampleRate / 11025));
  const sr = sampleRate / dec;
  const n = Math.floor(frame.length / dec);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < dec; k++) s += frame[i * dec + k];
    x[i] = s / dec;
  }
  // pre-emphasis + window
  const w = getHann(n);
  for (let i = n - 1; i > 0; i--) x[i] = (x[i] - 0.95 * x[i - 1]) * w[i];
  x[0] = 0;
  const order = Math.round(5 + sr / 1000);
  const a = lpcCoefficients(x, order);
  if (!a) return null;
  // evaluate |1/A(e^jw)| on a grid
  const fmin = 180;
  const fmax = 3600;
  const step = 10;
  const bins = Math.floor((fmax - fmin) / step) + 1;
  const env = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    const wv = (2 * Math.PI * (fmin + b * step)) / sr;
    let re = 0;
    let im = 0;
    for (let k = 0; k <= order; k++) {
      re += a[k] * Math.cos(wv * k);
      im -= a[k] * Math.sin(wv * k);
    }
    env[b] = 1 / Math.sqrt(re * re + im * im + 1e-12);
  }
  const peaks: { f: number; v: number }[] = [];
  for (let b = 1; b < bins - 1; b++) {
    if (env[b] > env[b - 1] && env[b] >= env[b + 1]) peaks.push({ f: fmin + b * step, v: env[b] });
  }
  if (!peaks.length) return null;
  // F1: lowest strong peak in 200-1000; F2: next strong peak above F1+250
  const strongest = Math.max(...peaks.map((p) => p.v));
  const strong = peaks.filter((p) => p.v > strongest * 0.2).sort((p, q) => p.f - q.f);
  const f1p = strong.find((p) => p.f >= 200 && p.f <= 1000);
  if (!f1p) return null;
  const f2p = strong.find((p) => p.f > f1p.f + 160 && p.f <= 3200);
  return { f1: f1p.f, f2: f2p ? f2p.f : f1p.f + 600 };
}

// ------------------------------------------------------------------ classification
const VOWEL_REF: { v: Viseme; f1: number; f2: number }[] = [
  { v: "aa", f1: 730, f2: 1090 },
  { v: "E", f1: 530, f2: 1840 },
  { v: "I", f1: 270, f2: 2290 },
  { v: "O", f1: 570, f2: 840 },
  { v: "U", f1: 300, f2: 870 },
];

export function classifyVowel(f1: number, f2: number): Partial<Record<Viseme, number>> {
  const out: Partial<Record<Viseme, number>> = {};
  let sum = 0;
  for (const r of VOWEL_REF) {
    const d1 = Math.log2(f1 / r.f1) / 0.22;
    const d2 = Math.log2(f2 / r.f2) / 0.2;
    const w = Math.exp(-0.5 * (d1 * d1 + d2 * d2));
    out[r.v] = w;
    sum += w;
  }
  if (sum < 1e-6) return { aa: 1 };
  for (const k of Object.keys(out) as Viseme[]) out[k]! /= sum;
  return out;
}

export interface FrameFeatures {
  rms: number;
  /** share of energy above 3.5 kHz */
  hiRatio: number;
  /** share of energy below 1 kHz */
  loRatio: number;
  zcr: number;
  formants: { f1: number; f2: number } | null;
}

export function frameFeatures(frame: Float32Array, sampleRate: number): FrameFeatures {
  const n = frame.length;
  let sq = 0;
  let zc = 0;
  for (let i = 0; i < n; i++) {
    sq += frame[i] * frame[i];
    if (i && (frame[i] >= 0) !== (frame[i - 1] >= 0)) zc++;
  }
  const rms = Math.sqrt(sq / n);
  // power-of-two FFT size
  let N = 1;
  while (N < n) N <<= 1;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const w = getHann(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * w[i];
  fft(re, im);
  const binHz = sampleRate / N;
  let lo = 0;
  let hi = 0;
  let tot = 0;
  for (let i = 1; i < N / 2; i++) {
    const f = i * binHz;
    const p = re[i] * re[i] + im[i] * im[i];
    if (f < 80 || f > 10000) continue;
    tot += p;
    if (f < 1000) lo += p;
    else if (f > 3500) hi += p;
  }
  const formants = rms > 1e-4 ? estimateFormants(frame, sampleRate) : null;
  return { rms, hiRatio: tot > 0 ? hi / tot : 0, loRatio: tot > 0 ? lo / tot : 0, zcr: zc / n, formants };
}

export interface FrameClass {
  weights: Partial<Record<Viseme, number>>;
  /** loudness relative to the reference level, 0..1+ */
  level: number;
}

/** @param ref reference "loud speech" RMS used to normalise levels */
export function classifyFrame(f: FrameFeatures, ref: number, gate = 0.06): FrameClass {
  const level = f.rms / Math.max(ref, 1e-6);
  if (level < gate) return { weights: { sil: 1 }, level };
  if (f.hiRatio > 0.5 && f.zcr > 0.12) {
    return { weights: f.hiRatio > 0.7 ? { SS: 1 } : { CH: 1 }, level };
  }
  if (f.formants) return { weights: classifyVowel(f.formants.f1, f.formants.f2), level };
  return { weights: { nn: 1 }, level };
}

/** RMS of quiet speech; below this level the reference is never lowered */
export const MIN_REF_RMS = 0.02;

export interface AnalyzeOptions {
  /** analysis hop in seconds */
  hop?: number;
  /** analysis window in seconds */
  window?: number;
  /** drop viseme runs shorter than this many frames (flicker suppression) */
  minRun?: number;
}
export interface AudioAnalysis {
  events: VisemeEvent[];
  /** loudness envelope 0..1 sampled every `hop` seconds (for hybrid gating) */
  envelope: Float32Array;
  hop: number;
  duration: number;
}

/** Offline analysis of a decoded mono PCM buffer -> viseme timeline + loudness envelope. */
export function analyzeAudioBuffer(samples: Float32Array, sampleRate: number, o: AnalyzeOptions = {}): AudioAnalysis {
  const hop = o.hop ?? 0.02;
  const winN = Math.max(256, Math.round((o.window ?? 0.04) * sampleRate));
  const hopN = Math.round(hop * sampleRate);
  const frames: FrameFeatures[] = [];
  for (let s = 0; s + winN <= samples.length; s += hopN) {
    frames.push(frameFeatures(samples.subarray(s, s + winN), sampleRate));
  }
  const rmsSorted = frames.map((f) => f.rms).sort((a, b) => a - b);
  // absolute floor: audio that is quiet overall (noise, near-silence) must not be normalised up to "speech"
  const ref = rmsSorted.length ? Math.max(rmsSorted[Math.floor(rmsSorted.length * 0.95)], MIN_REF_RMS) : MIN_REF_RMS;
  const cls = frames.map((f) => classifyFrame(f, ref));
  const env = new Float32Array(cls.length);
  cls.forEach((c, i) => (env[i] = Math.min(1, c.level)));

  const top = cls.map((c) => {
    let best: Viseme = "sil";
    let bw = -1;
    for (const [v, w] of Object.entries(c.weights) as [Viseme, number][]) if (w > bw) (best = v), (bw = w);
    return { v: best, w: bw, level: c.level };
  });
  // flicker suppression: runs shorter than minRun inherit the previous viseme
  const minRun = o.minRun ?? 2;
  let i = 0;
  while (i < top.length) {
    let j = i;
    while (j < top.length && top[j].v === top[i].v) j++;
    if (j - i < minRun && i > 0) for (let k = i; k < j; k++) top[k] = { ...top[i - 1] };
    i = j;
  }
  const events: VisemeEvent[] = [];
  i = 0;
  while (i < top.length) {
    let j = i;
    let acc = 0;
    while (j < top.length && top[j].v === top[i].v) acc += top[j].w * Math.min(1, 0.35 + 0.65 * top[j].level), j++;
    const v = top[i].v;
    const weight = v === "sil" ? 0 : Math.min(1, (acc / (j - i)) * (0.6 + 0.4 * VISEME_OPENNESS[v] + 0.3));
    // frame i covers [i*hop, i*hop+win]; its content is centred win/2 later
    events.push({ time: i * hop + (o.window ?? 0.04) / 2, duration: (j - i) * hop, viseme: v, weight });
    i = j;
  }
  return { events, envelope: env, hop, duration: samples.length / sampleRate };
}

/** Peak-normalised RMS loudness envelope (0..1) of a buffer sampled every `hop` seconds. */
export function loudnessEnvelope(samples: Float32Array, sampleRate: number, hop = 0.01): Float32Array {
  const hopN = Math.round(hop * sampleRate);
  const n = Math.ceil(samples.length / hopN);
  const out = new Float32Array(n);
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const a = i * hopN;
    const b = Math.min(samples.length, a + hopN * 2);
    for (let k = a; k < b; k++) s += samples[k] * samples[k];
    out[i] = Math.sqrt(s / Math.max(1, b - a));
    peak = Math.max(peak, out[i]);
  }
  for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}
