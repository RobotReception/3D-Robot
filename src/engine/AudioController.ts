import { analyzeAudioBuffer, loudnessEnvelope, type AudioAnalysis } from "./lipsync/audioAnalysis";
import type { LiveFrameSource } from "./lipsync/LipSyncController";

export function pcm16ToFloat32(data: ArrayBuffer | Int16Array): Float32Array {
  const i16 = data instanceof Int16Array ? data : new Int16Array(data.byteLength % 2 ? data.slice(0, data.byteLength - 1) : data);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

export function mixToMono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

export interface LoadedAudio {
  buffer: AudioBuffer;
  analysis: AudioAnalysis;
  envelope: { data: Float32Array; hop: number };
}

export interface PlayingAudio {
  /** seconds since playback started (audio clock) */
  time: () => number;
  stop: () => void;
  ended: Promise<void>;
  duration: number;
}

export interface PcmStream {
  /** append signed 16-bit little-endian mono PCM */
  pushPCM16(chunk: ArrayBuffer | Int16Array): void;
  pushFloat32(chunk: Float32Array): void;
  /** no more data will arrive */
  end(): void;
  time: () => number;
  ended: Promise<void>;
  stop: () => void;
}

/**
 * Web Audio plumbing: decode + analyse files, play them with an audio clock,
 * stream PCM chunks gaplessly, and expose an AnalyserNode as a LiveFrameSource.
 * Requires a user gesture before audio can start (browser autoplay policy).
 */
export class AudioController {
  private _ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private master: GainNode | null = null;
  private currentStop: (() => void) | null = null;
  volume = 1;

  get ctx(): AudioContext {
    if (!this._ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this._ctx = new Ctor();
      this.master = this._ctx.createGain();
      this.analyser = this._ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.master.connect(this.analyser);
      this.analyser.connect(this._ctx.destination);
    }
    return this._ctx;
  }
  static get supported() {
    return typeof window !== "undefined" && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);
  }

  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /** Live frames of whatever is currently playing through the controller. */
  liveSource(): LiveFrameSource {
    this.ctx;
    const a = this.analyser!;
    return { sampleRate: this.ctx.sampleRate, size: a.fftSize, read: (out) => a.getFloatTimeDomainData(out as Float32Array<ArrayBuffer>) };
  }

  async decode(data: ArrayBuffer): Promise<LoadedAudio> {
    const buffer = await this.ctx.decodeAudioData(data.slice(0));
    const mono = mixToMono(buffer);
    const analysis = analyzeAudioBuffer(mono, buffer.sampleRate);
    const hop = 0.01;
    return { buffer, analysis, envelope: { data: loudnessEnvelope(mono, buffer.sampleRate, hop), hop } };
  }
  async load(url: string): Promise<LoadedAudio> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch audio ${url}: ${res.status}`);
    return this.decode(await res.arrayBuffer());
  }
  async loadFile(file: File): Promise<LoadedAudio> {
    return this.decode(await file.arrayBuffer());
  }

  play(buffer: AudioBuffer): PlayingAudio {
    this.stop();
    const ctx = this.ctx;
    this.master!.gain.value = this.volume;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.master!);
    const t0 = ctx.currentTime + 0.05;
    let done!: () => void;
    const ended = new Promise<void>((r) => (done = r));
    src.onended = () => done();
    src.start(t0);
    const stop = () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      done();
    };
    this.currentStop = stop;
    return { time: () => Math.max(0, ctx.currentTime - t0), stop, ended, duration: buffer.duration };
  }

  /** Streaming playback of PCM chunks with sample-accurate scheduling. */
  createPcmStream(sampleRate = 24000): PcmStream {
    this.stop();
    const ctx = this.ctx;
    this.master!.gain.value = this.volume;
    let next = ctx.currentTime + 0.12; // small jitter buffer
    const t0 = next;
    let ended = false;
    let lastSrc: AudioBufferSourceNode | null = null;
    let done!: () => void;
    const endedP = new Promise<void>((r) => (done = r));
    const sources = new Set<AudioBufferSourceNode>();
    const push = (f: Float32Array) => {
      if (!f.length || ended) return;
      const b = ctx.createBuffer(1, f.length, sampleRate);
      b.copyToChannel(f as Float32Array<ArrayBuffer>, 0);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.master!);
      const start = Math.max(next, ctx.currentTime);
      s.start(start);
      next = start + b.duration;
      sources.add(s);
      lastSrc = s;
      s.onended = () => {
        sources.delete(s);
        if (ended && sources.size === 0) done();
      };
    };
    const stop = () => {
      ended = true;
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* noop */
        }
      }
      sources.clear();
      done();
    };
    this.currentStop = stop;
    return {
      pushPCM16: (c) => push(pcm16ToFloat32(c)),
      pushFloat32: push,
      end: () => {
        ended = true;
        if (!lastSrc || sources.size === 0) done();
      },
      time: () => Math.max(0, ctx.currentTime - t0),
      ended: endedP,
      stop,
    };
  }

  stop() {
    this.currentStop?.();
    this.currentStop = null;
  }

  dispose() {
    this.stop();
    void this._ctx?.close();
    this._ctx = null;
  }
}

// ------------------------------------------------------------------ browser TTS
export interface SpeechSynthesisHandle {
  stop(): void;
  ended: Promise<void>;
  /** word-boundary callback (charIndex into the text), fires only if the voice reports boundaries */
  onBoundary?: (charIndex: number, elapsed: number) => void;
}

export const speechSynthesisAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function speakWithBrowserTTS(text: string, opts: { lang?: string; rate?: number; pitch?: number; voice?: string } = {}): SpeechSynthesisHandle {
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(text);
  if (opts.lang) u.lang = opts.lang;
  u.rate = opts.rate ?? 1;
  u.pitch = opts.pitch ?? 1;
  if (opts.voice) {
    const v = synth.getVoices().find((x) => x.name === opts.voice);
    if (v) u.voice = v;
  } else if (opts.lang) {
    const v = synth.getVoices().find((x) => x.lang.toLowerCase().startsWith(opts.lang!.toLowerCase().slice(0, 2)));
    if (v) u.voice = v;
  }
  let resolve!: () => void;
  const ended = new Promise<void>((r) => (resolve = r));
  const handle: SpeechSynthesisHandle = { stop: () => synth.cancel(), ended };
  const t0 = performance.now();
  u.onend = () => resolve();
  u.onerror = () => resolve();
  u.onboundary = (e) => handle.onBoundary?.(e.charIndex, (performance.now() - t0) / 1000);
  synth.cancel();
  synth.speak(u);
  return handle;
}
