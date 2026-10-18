/** Formant synthesiser used to build audio with *known* content for lip-sync tests and the demo WAV files. */
export const FORMANTS: Record<string, [number, number, number]> = {
  aa: [730, 1090, 2440],
  E: [530, 1840, 2480],
  I: [270, 2290, 3010],
  O: [570, 840, 2410],
  U: [300, 870, 2240],
};

export interface Segment {
  kind: "vowel" | "fric" | "sil" | "nasal";
  /** vowel label (aa, E, I, O, U) */
  v?: string;
  dur: number;
  amp?: number;
}
export interface LabeledAudio {
  samples: Float32Array;
  sampleRate: number;
  /** ground truth: [start, end, label] with label = vowel / SS / sil / nn */
  labels: { start: number; end: number; label: string }[];
}

function resonate(x: Float32Array, f: number, bw: number, fs: number) {
  const r = Math.exp((-Math.PI * bw) / fs);
  const c = 2 * r * Math.cos((2 * Math.PI * f) / fs);
  const y = new Float32Array(x.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] + c * y1 - r * r * y2;
    y[i] = v;
    y2 = y1;
    y1 = v;
  }
  return y;
}

export function synthesize(segs: Segment[], fs = 16000, f0 = 120, seed = 7): LabeledAudio {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const out: number[] = [];
  const labels: LabeledAudio["labels"] = [];
  let t = 0;
  for (const seg of segs) {
    const n = Math.round(seg.dur * fs);
    const buf = new Float32Array(n);
    let label = "sil";
    const amp = seg.amp ?? 0.5;
    if (seg.kind === "vowel" || seg.kind === "nasal") {
      const [F1, F2, F3] = seg.kind === "nasal" ? ([250, 1000, 2300] as const) : FORMANTS[seg.v!];
      const src = new Float32Array(n);
      const period = Math.round(fs / f0);
      for (let i = 0; i < n; i += period) src[i] = 1;
      let y = resonate(src, F1, 60, fs);
      const y2 = resonate(src, F2, 90, fs);
      const y3 = resonate(src, F3, 120, fs);
      const mix = new Float32Array(n);
      for (let i = 0; i < n; i++) mix[i] = y[i] + 0.7 * y2[i] + 0.35 * y3[i];
      y = mix;
      let peak = 1e-9;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(y[i]));
      const a = seg.kind === "nasal" ? amp * 0.5 : amp;
      for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / (0.015 * fs), (n - i) / (0.02 * fs));
        buf[i] = (y[i] / peak) * a * env;
      }
      label = seg.kind === "nasal" ? "nn" : seg.v!;
    } else if (seg.kind === "fric") {
      let p1 = 0;
      let p2 = 0;
      for (let i = 0; i < n; i++) {
        const w = rnd();
        const hp = w - p1 * 1.6 + p2 * 0.7; // crude high-pass emphasis
        p2 = p1;
        p1 = w;
        const env = Math.min(1, i / (0.01 * fs), (n - i) / (0.01 * fs));
        buf[i] = Math.max(-1, Math.min(1, hp * 0.4 * (seg.amp ?? 0.6) * env));
      }
      label = "SS";
    }
    for (let i = 0; i < n; i++) out.push(buf[i]);
    labels.push({ start: t, end: t + seg.dur, label });
    t += seg.dur;
  }
  return { samples: Float32Array.from(out), sampleRate: fs, labels };
}

/** 16-bit PCM mono WAV encoder */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}

export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = v.getUint32(24, true);
  const n = (bytes.byteLength - 44) / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = v.getInt16(44 + i * 2, true) / 32768;
  return { samples, sampleRate };
}
