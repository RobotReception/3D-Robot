import type * as THREE from "three";
import { executeAction, LOBBY_PLACES, parseActionTag, type ActionContext, type ActionResult, type ActionRobot, type Place, type RobotAction } from "./actions";
import { ASSISTANT_EMOTIONS, ASSISTANT_GESTURES, buildSystemPrompt, type PromptOptions } from "./assistantPrompt";
import { ackWord, describeAction, failureMessage, parseCommands, type ParsedCommand } from "./chatCommands";
import { Emitter } from "./events";
import type { EmotionName } from "./FaceController";
import { activeIntervals, alignTextToActivity } from "./lipsync/align";
import { textToVisemeEvents } from "./lipsync/phonemizer";
import type { VisemeEvent } from "./lipsync/visemes";
import type { AssistantState } from "./stateMachine";

// ======================================================================= backends
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}
export interface ChatRequest {
  messages: ChatMessage[];
  /** system prompt (a server may ignore it and use its own) */
  system: string;
  language?: string;
}
/** Any LLM: yield the answer as it is generated (text deltas of any size). */
export interface ChatBackend {
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<string>;
}
/** Any speech synthesiser that returns mono signed 16-bit PCM. */
export interface TtsBackend {
  /** sample rate of the PCM it returns (Gemini TTS: 24000) */
  sampleRate: number;
  synth(text: string, signal: AbortSignal): Promise<Int16Array | ArrayBuffer | null>;
}

/** The parts of RobotAvatar the assistant drives (kept narrow so tests can fake it). */
export interface AssistantRobot {
  setState(s: AssistantState): void;
  setEmotion(e: EmotionName, intensity?: number): void;
  playAnimation(name: string): unknown;
  speakStream(o?: { sampleRate?: number; emotion?: EmotionName; gestures?: boolean }): {
    pushPCM16(c: Int16Array): void;
    pushVisemes(ev: VisemeEvent[]): void;
    end(): void;
    stop(): void;
    time(): number;
    finished: Promise<void>;
  };
  speak(o: { text: string; emotion?: EmotionName; gestures?: boolean }): { finished: Promise<void>; stop(): void };
  stopSpeech(): void;
  after(seconds: number, fn: () => void): void;
  defaultEmotion: EmotionName;
}

// ======================================================================= directives
export type Directive = { name: "emotion"; value: EmotionName } | { name: "gesture"; value: string } | { name: "action"; value: RobotAction };
export type StreamPiece = { type: "text"; text: string } | { type: "tag"; tag: Directive };

const TAG_RE = /^\[\s*(emotion|gesture|action)\s*[=:]\s*([A-Za-z0-9_.:-]+)\s*\]$/i;
const MAX_TAG = 40;

/**
 * Splits an LLM text stream into plain text and `[emotion=x]` / `[gesture=x]` / `[action=x]` directives. A tag may
 * arrive split across chunks. Unknown names are dropped silently (never spoken); other square brackets stay text.
 */
export class DirectiveParser {
  private buf = "";
  constructor(private places: string[] = Object.keys(LOBBY_PLACES)) {}
  push(chunk: string): StreamPiece[] {
    this.buf += chunk;
    return this.drain(false);
  }
  flush(): StreamPiece[] {
    return this.drain(true);
  }
  private drain(final: boolean): StreamPiece[] {
    const out: StreamPiece[] = [];
    const text = (s: string) => s && out.push({ type: "text", text: s });
    for (;;) {
      const i = this.buf.indexOf("[");
      if (i < 0) {
        text(this.buf);
        this.buf = "";
        break;
      }
      text(this.buf.slice(0, i));
      this.buf = this.buf.slice(i);
      const j = this.buf.indexOf("]");
      if (j < 0) {
        if (this.buf.length > MAX_TAG || final) {
          text(this.buf);
          this.buf = "";
        }
        break; // wait for the closing bracket
      }
      const raw = this.buf.slice(0, j + 1);
      const m = TAG_RE.exec(raw);
      this.buf = this.buf.slice(j + 1);
      if (!m) {
        text(raw);
        continue;
      }
      const name = m[1].toLowerCase() as "emotion" | "gesture" | "action";
      const value = m[2].toLowerCase();
      if (name === "action") {
        const a = parseActionTag(value, this.places);
        if (a) out.push({ type: "tag", tag: { name, value: a } });
      } else if (name === "emotion" && (ASSISTANT_EMOTIONS as string[]).includes(value)) out.push({ type: "tag", tag: { name, value: value as EmotionName } });
      else if (name === "gesture" && (ASSISTANT_GESTURES as readonly string[]).includes(value)) out.push({ type: "tag", tag: { name, value } });
      // unknown value: swallowed
    }
    return out;
  }
}

// ======================================================================= sentences
const ABBREV = /(?:\b(?:dr|mr|mrs|ms|prof|st|vs|etc|e\.g|i\.e|no)|[A-Za-z]\.[A-Za-z])\.$/i;

/**
 * Cuts streamed text into speakable chunks at sentence ends so speech can start on the first sentence while the rest
 * is still being generated. The first chunk may be shorter (faster start); very long sentences are cut at commas.
 */
export class SentenceChunker {
  private buf = "";
  constructor(private o: { minFirst?: number; min?: number; max?: number } = {}) {}
  private first = true;

  push(text: string): string[] {
    this.buf += text;
    return this.cut(false);
  }
  flush(): string[] {
    return this.cut(true);
  }
  /** text not yet emitted */
  get pending() {
    return this.buf;
  }

  private cut(final: boolean): string[] {
    const out: string[] = [];
    const minFirst = this.o.minFirst ?? 14, min = this.o.min ?? 28, max = this.o.max ?? 170;
    for (;;) {
      const need = this.first ? minFirst : min;
      let end = -1;
      for (let i = 0; i < this.buf.length; i++) {
        const c = this.buf[i];
        if (!".!?؟…\n".includes(c)) continue;
        let j = i;
        while (j + 1 < this.buf.length && ".!?؟…".includes(this.buf[j + 1])) j++; // "?!" "..."
        const next = this.buf[j + 1];
        if (next === undefined) {
          if (!final) break; // might continue ("..."): wait
          end = j + 1;
        } else if (/\s/.test(next) || "\"'»”)".includes(next)) {
          const before = this.buf.slice(Math.max(0, i - 4), j + 1);
          if (c === "." && (ABBREV.test(before) || /\d\.$/.test(before) && /^\s*\d/.test(this.buf.slice(j + 1)))) {
            i = j;
            continue;
          }
          end = j + 1;
        } else {
          i = j;
          continue;
        }
        if (this.buf.slice(0, end).trim().length >= need || (final && end >= this.buf.length)) break;
        end = -1; // too short ("Hi."): keep collecting
        i = j;
      }
      if (end < 0 && this.buf.length > max) {
        // no sentence end in sight: cut at the last comma / space before the limit
        const win = this.buf.slice(0, max);
        const k = Math.max(win.lastIndexOf(","), win.lastIndexOf("،"), win.lastIndexOf(";"), win.lastIndexOf(":"));
        end = k > 40 ? k + 1 : win.lastIndexOf(" ") > 40 ? win.lastIndexOf(" ") : max;
      }
      if (end < 0) break;
      const s = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (s) {
        out.push(s);
        this.first = false;
      }
    }
    if (final && this.buf.trim()) {
      out.push(this.buf.trim());
      this.buf = "";
      this.first = false;
    }
    if (final) this.buf = "";
    return out;
  }
}

// ======================================================================= audio helpers
/** loudness envelope (0..1) of 16-bit PCM, `hop` seconds per sample, for aligning text visemes to the real audio */
export function pcmEnvelope(pcm: Int16Array, sampleRate: number, hop = 0.01): { data: Float32Array; hop: number } {
  const n = Math.max(1, Math.round(sampleRate * hop));
  const out = new Float32Array(Math.ceil(pcm.length / n));
  let peak = 1e-6;
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    const a = k * n, b = Math.min(pcm.length, a + n);
    for (let i = a; i < b; i++) s += (pcm[i] / 32768) ** 2;
    out[k] = Math.sqrt(s / Math.max(1, b - a));
    peak = Math.max(peak, out[k]);
  }
  for (let k = 0; k < out.length; k++) out[k] /= peak;
  return { data: out, hop };
}

/** resolves when `p` does, or as soon as the signal aborts */
const until = (p: Promise<void>, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
    p.then(resolve, reject);
  });

/** mouth shapes for `text`, aligned to when the real audio is active (falls back to timing from the text alone) */
function alignedVisemes(text: string, pcm: Int16Array, sr: number): VisemeEvent[] {
  let ev: VisemeEvent[] = [];
  try {
    const env = pcmEnvelope(pcm, sr);
    ev = alignTextToActivity(text, activeIntervals(env.data, env.hop, { threshold: 0.06 }));
  } catch {
    /* fall back below */
  }
  return ev.length ? ev : textToVisemeEvents(text, { totalDuration: Math.max(0.2, (pcm.length / sr) * 0.95) });
}

const toInt16 = (x: Int16Array | ArrayBuffer): Int16Array => (x instanceof Int16Array ? x : new Int16Array(x.byteLength & 1 ? x.slice(0, x.byteLength - 1) : x));

// ======================================================================= the assistant
export interface AssistantOptions {
  chat: ChatBackend;
  /** without a TTS backend the whole answer is collected and spoken with the browser voice (higher latency) */
  tts?: TtsBackend;
  /** persona for the built-in system prompt, or a complete `system` string */
  persona?: PromptOptions;
  system?: string;
  /** messages kept as context (default 16) */
  maxHistory?: number;
  /** parallel TTS requests (default 2): the next sentence is synthesised while the current one plays */
  prefetch?: number;
  language?: string;
  /** orders typed in the chat ("تقدم مترين", "go to the desk") run at once without the LLM; `false` turns that off */
  commands?: false | CommandOptions;
}

export interface CommandOptions {
  /** named spots ("desk"...) the robot can walk to (default: the lobby of the built-in environment) */
  places?: Record<string, Place>;
  /** where "go back" goes (default: where the robot stood when the assistant was created) */
  home?: Place;
  /** longest single move in metres (default 6) */
  maxMeters?: number;
  /** what "look at me" looks at (default: the state machine's userTarget, i.e. the camera) */
  userTarget?: () => THREE.Object3D | null;
  /** say a short "okay" and report problems aloud (default true); false = silent, the result still has the text */
  voice?: boolean;
}

export type AssistantEvents = {
  state: { state: "idle" | "thinking" | "speaking" | "acting" | "error" };
  /** an order was recognised locally (before it runs) */
  command: { text: string; actions: RobotAction[]; lang: "ar" | "en" };
  /** one action finished (`source`: typed order or an [action=...] tag from the LLM) */
  action: { action: RobotAction; result: ActionResult; index: number; source: "chat" | "llm" };
  /** a sentence starts being spoken (plain text, directives removed) */
  sentence: { text: string; index: number };
  tag: { tag: Directive; at: number };
  answer: { text: string; aborted: boolean };
  error: { message: string; stage: "chat" | "tts" | "robot" };
};

export interface AskResult {
  text: string;
  aborted: boolean;
  error?: string;
  /** set when the message was an order the robot carried out itself (no LLM call) */
  commands?: ActionResult[];
}

interface Chunk {
  text: string;
  tags: Directive[];
  index: number;
  audio?: Promise<Int16Array | null>;
}

/**
 * Question in, performed answer out. Works with any LLM / TTS through `ChatBackend` / `TtsBackend` (see docs/GEMINI.md
 * for Gemini).
 *
 *   ask("...")
 *     → robot "thinking" at once (hand to chin, glance away)
 *     → answer text streams in; `[emotion=..]`/`[gesture=..]` tags are removed and run when their sentence is spoken
 *     → sentences go to TTS (next one prefetched), audio is streamed gaplessly into robot.speakStream
 *     → text visemes (with accents and punctuation) are aligned to the REAL audio, so the mouth, nods, brows and hand
 *       beats follow the words (SpeechPerformer)
 *     → back to idle; the reply is added to the history
 *
 * A new `ask()` or `cancel()` interrupts everything (barge-in). Errors put the robot in its "error" state.
 */
export class RobotAssistant extends Emitter<AssistantEvents> {
  readonly history: ChatMessage[] = [];
  private ctl: AbortController | null = null;
  private busy = false;
  /** what the running answer has said so far (committed to the history if it gets interrupted) */
  private partial: (() => string) | null = null;
  /** actions (typed orders or LLM tags) currently running */
  private acting = 0;
  private home: Place | null = null;

  constructor(private robot: AssistantRobot, readonly options: AssistantOptions) {
    super();
    const r = robot as Partial<ActionRobot>;
    if (r.root && typeof r.walkTo === "function") {
      this.home = this.options.commands ? this.options.commands.home ?? null : null;
      this.home ??= { x: r.root.position.x, z: r.root.position.z, facing: (r.root.rotation.y * 180) / Math.PI };
    }
  }

  /** the robot as something that can act, plus where it may go; null when orders are off or the robot cannot walk (test fakes) */
  private actor(): { robot: AssistantRobot & ActionRobot; ctx: ActionContext; o: CommandOptions } | null {
    if (this.options.commands === false || !this.home) return null;
    const robot = this.robot as AssistantRobot & ActionRobot;
    if (typeof robot.walkTo !== "function") return null;
    const o = this.options.commands ?? {};
    const sm = (this.robot as { stateMachine?: { userTarget?: THREE.Object3D | null } }).stateMachine;
    return { robot, o, ctx: { places: o.places ?? LOBBY_PLACES, home: this.home, maxMeters: o.maxMeters, userTarget: o.userTarget?.() ?? sm?.userTarget ?? null } };
  }

  get thinking() {
    return this.busy;
  }
  get systemPrompt() {
    return this.options.system ?? buildSystemPrompt(this.options.persona);
  }

  /** stop talking / thinking now (the user interrupts); the robot returns to idle. `motion: false` lets a walk in progress finish. */
  cancel(o: { motion?: boolean } = {}) {
    const was = this.busy;
    this.commitPartial();
    this.abort();
    if (this.acting > 0 && o.motion !== false) (this.robot as Partial<ActionRobot>).stop?.();
    if (was) {
      this.busy = false;
      this.robot.setState("idle");
      this.emit("state", { state: "idle" });
    }
  }
  /** an interrupted answer stays in the context as far as it was spoken, so "no, I meant..." makes sense to the model */
  private commitPartial() {
    const said = this.busy ? this.partial?.().trim() : "";
    if (said) this.history.push({ role: "assistant", text: said });
    this.partial = null;
  }
  private abort() {
    this.ctl?.abort();
    this.robot.stopSpeech();
  }
  reset() {
    this.cancel();
    this.history.length = 0;
  }

  /**
   * `opts.commands: false` sends the message to the LLM even if it reads like an order.
   */
  async ask(question: string, opts: { commands?: boolean } = {}): Promise<AskResult> {
    const q = question.trim();
    if (!q) return { text: "", aborted: false };
    if (opts.commands !== false && this.actor()) {
      const cmd = parseCommands(q);
      if (cmd) return this.runCommand(q, cmd);
    }
    if (this.busy) {
      // barge-in: interrupt the running answer (the new question sets "thinking" next)
      this.commitPartial();
      this.abort();
    }
    const ctl = new AbortController();
    this.ctl = ctl;
    const { signal } = ctl;
    const robot = this.robot;
    this.busy = true;
    this.history.push({ role: "user", text: q });
    const trimHistory = () => {
      const max = this.options.maxHistory ?? 16;
      if (this.history.length > max) this.history.splice(0, this.history.length - max);
    };
    trimHistory();
    robot.setState("thinking");
    this.emit("state", { state: "thinking" });

    const parser = new DirectiveParser(Object.keys(this.actor()?.ctx.places ?? LOBBY_PLACES));
    const chunker = new SentenceChunker();
    const chunks: Chunk[] = [];
    let pendingTags: Directive[] = [];
    let spoken = "";
    let said = ""; // sentences that have actually started playing
    this.partial = () => said;
    let streamDone = false;
    let wake: (() => void) | null = null;
    const notify = () => wake?.();
    const fail = (stage: "chat" | "tts" | "robot", e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      this.emit("error", { message, stage });
      return message;
    };

    // ---- stage 1: LLM -> chunks (with prefetching TTS)
    const synthSlots = Math.max(1, this.options.prefetch ?? 2);
    let inflight = 0;
    const waiting: (() => void)[] = [];
    const tts = this.options.tts;
    const synth = (text: string): Promise<Int16Array | null> =>
      new Promise((resolve) => {
        const go = async () => {
          inflight++;
          try {
            const r = await tts!.synth(text, signal);
            resolve(r ? toInt16(r) : null);
          } catch (e) {
            if (!signal.aborted) fail("tts", e);
            resolve(null);
          } finally {
            inflight--;
            waiting.shift()?.();
          }
        };
        if (inflight < synthSlots) void go();
        else waiting.push(() => void go());
      });
    const addChunk = (text: string) => {
      const c: Chunk = { text, tags: pendingTags, index: chunks.length };
      pendingTags = [];
      if (tts && text) c.audio = synth(text);
      chunks.push(c);
      notify();
    };
    const feed = (pieces: StreamPiece[]) => {
      for (const p of pieces) {
        if (p.type === "tag") {
          for (const s of chunker.flush()) addChunk(s); // a tag starts a new sentence: close the one before it
          pendingTags.push(p.tag);
        } else for (const s of chunker.push(p.text)) addChunk(s);
      }
    };
    let chatError: unknown = null;
    const producer = (async () => {
      try {
        for await (const delta of this.options.chat.stream({ messages: [...this.history], system: this.systemPrompt, language: this.options.language }, signal)) {
          if (signal.aborted) return;
          feed(parser.push(delta));
        }
        feed(parser.flush());
        for (const s of chunker.flush()) addChunk(s);
        if (pendingTags.length) {
          addChunk(""); // tags with no text after them (e.g. a closing [gesture=goodbye])
        }
      } catch (e) {
        if (!signal.aborted) chatError = e;
      } finally {
        streamDone = true;
        notify();
      }
    })();
    const next = async (i: number): Promise<Chunk | null> => {
      for (;;) {
        if (chunks[i]) return chunks[i];
        if (streamDone || signal.aborted) return null;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    };

    // ---- stage 2: chunks -> robot
    let stream: ReturnType<AssistantRobot["speakStream"]> | null = null;
    let offset = 0; // seconds of audio already pushed
    const sr = tts?.sampleRate ?? 24000;
    const prevEmotion = robot.defaultEmotion;
    const timers: { at: number; fn: () => void }[] = [];
    let ticking = false;
    // [action=...] tags from the model run one after another, starting when their sentence starts
    let actions: Promise<void> = Promise.resolve();
    let actionIndex = 0;
    const runAction = (a: RobotAction) => {
      const act = this.actor();
      if (!act) return;
      const index = actionIndex++;
      this.acting++;
      actions = actions
        .then(async () => {
          if (signal.aborted) return;
          const result = await executeAction(act.robot, a, act.ctx, { settle: true });
          this.emit("action", { action: a, result, index, source: "llm" });
        })
        .catch((e) => void fail("robot", e))
        .finally(() => void this.acting--);
    };
    const runTag = (tag: Directive) => {
      try {
        if (tag.name === "emotion") robot.setEmotion(tag.value);
        else if (tag.name === "action") runAction(tag.value);
        else robot.playAnimation(tag.value);
      } catch {
        /* unknown clip on a custom rig: ignore */
      }
      this.emit("tag", { tag, at: stream?.time() ?? 0 });
    };
    const tick = () => {
      if (!stream || signal.aborted) {
        ticking = false;
        return;
      }
      const now = stream.time();
      while (timers.length && timers[0].at <= now + 0.02) timers.shift()!.fn();
      if (timers.length || !streamDone) robot.after(0.04, tick);
      else ticking = false;
    };
    // things that must happen when a sentence actually starts playing (not when its audio arrives)
    const schedule = (tags: Directive[], at: number, extra?: () => void) => {
      for (const t of tags) timers.push({ at, fn: () => runTag(t) });
      if (extra) timers.push({ at, fn: extra });
      timers.sort((a, b) => a.at - b.at);
      if (!ticking) {
        ticking = true;
        robot.after(0.04, tick);
      }
    };

    let fallbackText = "";
    let useFallback = !tts;
    let result: AskResult = { text: "", aborted: false };
    try {
      for (let i = 0; ; i++) {
        const c = await next(i);
        if (!c) break;
        if (signal.aborted) break;
        if (useFallback) {
          // no (working) TTS: collect, run tags immediately, speak the lot with the browser voice at the end
          for (const t of c.tags) runTag(t);
          fallbackText += (fallbackText ? " " : "") + c.text;
          continue;
        }
        const pcm = c.text ? await c.audio : null;
        if (signal.aborted) break;
        if (c.text && !pcm) {
          if (!stream) {
            useFallback = true; // TTS is down from the start: degrade to the browser voice instead of staying silent
            for (const t of c.tags) runTag(t);
            fallbackText += (fallbackText ? " " : "") + c.text;
          }
          continue;
        }
        if (!stream) {
          stream = robot.speakStream({ sampleRate: sr });
          this.emit("state", { state: "speaking" });
        }
        if (pcm) {
          stream.pushPCM16(pcm);
          const dur = pcm.length / sr;
          const ev = alignedVisemes(c.text, pcm, sr);
          stream.pushVisemes(ev.map((e) => ({ ...e, time: e.time + offset })));
          schedule(c.tags, offset, () => {
            said += (said ? " " : "") + c.text;
            this.emit("sentence", { text: c.text, index: c.index });
          });
          spoken += (spoken ? " " : "") + c.text;
          offset += dur;
        } else schedule(c.tags, offset); // tags only (no text)
      }
      await producer;
      if (chatError) throw chatError;
      if (signal.aborted) {
        robot.stopSpeech();
        result = { text: spoken || fallbackText, aborted: true };
      } else if (useFallback && fallbackText) {
        const h = robot.speak({ text: fallbackText });
        this.emit("state", { state: "speaking" });
        this.emit("sentence", { text: fallbackText, index: 0 });
        spoken = fallbackText;
        await until(h.finished, signal);
        result = { text: spoken, aborted: signal.aborted };
      } else if (stream) {
        stream.end();
        await until(stream.finished, signal); // an interruption must not wait for the audio to play out
        result = { text: said || spoken, aborted: signal.aborted };
      } else {
        robot.setState("idle");
        result = { text: "", aborted: false };
      }
      if (!signal.aborted) {
        for (const t of timers.splice(0)) t.fn(); // tags not polled yet (the audio has finished playing)
        await until(actions, signal); // a walk the model asked for finishes before the answer is done
      }
    } catch (e) {
      if (signal.aborted) {
        robot.stopSpeech();
        result = { text: spoken, aborted: true };
      } else {
        const message = fail(e === chatError ? "chat" : "robot", e);
        stream?.stop();
        robot.setState("error");
        this.emit("state", { state: "error" });
        this.history.pop(); // retry-friendly: the failed question is not kept
        this.busy = false;
        this.emit("answer", { text: "", aborted: false });
        return { text: "", aborted: false, error: message };
      }
    } finally {
      if (!signal.aborted) for (const t of timers.splice(0)) t.fn(); // whatever has not been polled yet (the audio has finished playing)
      timers.length = 0;
    }
    if (this.ctl === ctl) {
      this.busy = false;
      this.ctl = null;
    }
    if (!result.aborted) {
      if (result.text) this.history.push({ role: "assistant", text: result.text });
      trimHistory();
      try {
        robot.setEmotion(prevEmotion);
      } catch {
        /* ignore */
      }
      this.emit("state", { state: "idle" });
    }
    this.emit("answer", { text: result.text, aborted: result.aborted });
    return result;
  }

  // ------------------------------------------------------------------ orders typed in the chat
  private async runCommand(q: string, cmd: ParsedCommand): Promise<AskResult> {
    const act = this.actor()!;
    if (this.busy) {
      this.commitPartial();
      this.abort();
    }
    const ctl = new AbortController();
    this.ctl = ctl;
    const { signal } = ctl;
    this.busy = true;
    this.partial = null;
    this.history.push({ role: "user", text: q });
    const { lang, actions } = cmd;
    const voice = act.o.voice !== false;
    this.emit("command", { text: q, actions, lang });
    this.emit("state", { state: "acting" });

    const said: string[] = [];
    const speak = (text: string, gestures: boolean) => {
      said.push(text);
      return voice ? this.speakShort(text, signal, gestures) : Promise.resolve();
    };
    // a short "okay" while the body already moves (not with "stop": that silences the robot first; nor with "say ...")
    const plain = !actions.some((a) => a.type === "stop" || a.type === "say");
    let ack: Promise<void> = plain ? speak(ackWord(lang), false) : Promise.resolve();

    const results: ActionResult[] = [];
    for (let i = 0; i < actions.length && !signal.aborted; i++) {
      const a = actions[i];
      this.acting++;
      try {
        let r: ActionResult;
        if (a.type === "say") {
          await speak(a.text, true);
          r = { action: a, ok: true };
        } else r = await executeAction(act.robot, a, act.ctx, { settle: i < actions.length - 1 });
        results.push(r);
        this.emit("action", { action: a, result: r, index: i, source: "chat" });
      } catch (e) {
        const r: ActionResult = { action: a, ok: false, reason: "invalid" };
        results.push(r);
        this.emit("error", { message: e instanceof Error ? e.message : String(e), stage: "robot" });
        this.emit("action", { action: a, result: r, index: i, source: "chat" });
      } finally {
        this.acting--;
      }
    }
    if (!signal.aborted) {
      if (actions.some((a) => a.type === "stop") && !actions.some((a) => a.type === "say")) ack = speak(ackWord(lang), false);
      await until(ack, signal);
      const problem = results.map((r) => failureMessage(r, lang)).find(Boolean);
      if (problem) await until(speak(problem, false), signal);
    }
    if (this.ctl === ctl) {
      this.busy = false;
      this.ctl = null;
    }
    const text = said.join(" ");
    if (signal.aborted) return { text, aborted: true, commands: results };
    this.history.push({ role: "assistant", text: actions.map((a) => describeAction(a, lang)).join(lang === "ar" ? "، ثم " : ", then ") + (text ? ` (${text})` : "") });
    const max = this.options.maxHistory ?? 16;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
    this.emit("state", { state: "idle" });
    this.emit("answer", { text, aborted: false });
    return { text, aborted: false, commands: results };
  }

  /** speak one short line (acknowledgement / problem report) with the same voice and mouth sync as an answer */
  private async speakShort(text: string, signal: AbortSignal, gestures: boolean): Promise<void> {
    const robot = this.robot;
    const tts = this.options.tts;
    try {
      let pcm: Int16Array | null = null;
      if (tts) {
        try {
          const r = await tts.synth(text, signal);
          pcm = r ? toInt16(r) : null;
        } catch (e) {
          if (!signal.aborted) this.emit("error", { message: e instanceof Error ? e.message : String(e), stage: "tts" });
        }
      }
      if (signal.aborted) return;
      this.emit("sentence", { text, index: 0 });
      if (pcm && tts) {
        const s = robot.speakStream({ sampleRate: tts.sampleRate, gestures });
        s.pushPCM16(pcm);
        s.pushVisemes(alignedVisemes(text, pcm, tts.sampleRate));
        s.end();
        await until(s.finished, signal);
        if (signal.aborted) s.stop();
      } else {
        const h = robot.speak({ text, gestures });
        await until(h.finished, signal);
        if (signal.aborted) h.stop();
      }
    } catch (e) {
      if (!signal.aborted) this.emit("error", { message: e instanceof Error ? e.message : String(e), stage: "robot" });
    }
  }
}

// ======================================================================= voice input (browser)
export interface ListenOptions {
  /** BCP-47: "ar-SA", "en-US"... */
  lang?: string;
  /** called with interim text while the user speaks */
  onInterim?: (text: string) => void;
  signal?: AbortSignal;
}
type SR = { start(): void; stop(): void; abort(): void; lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null };

/** Is the browser's built-in speech recognition available (Chrome, Edge, Safari; needs https or localhost)? */
export const speechRecognitionAvailable = () =>
  typeof window !== "undefined" && !!((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);

/** Listen once and return what the user said ("" if nothing). The robot shows its listening pose meanwhile. */
export function listenOnce(robot: Pick<AssistantRobot, "setState">, o: ListenOptions = {}): Promise<string> {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return Promise.reject(new Error("Speech recognition is not supported in this browser"));
  return new Promise((resolve, reject) => {
    const rec = new Ctor();
    rec.lang = o.lang ?? "ar-SA";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let text = "";
    robot.setState("listening");
    rec.onresult = (e) => {
      text = Array.from(e.results).map((r) => r[0].transcript).join(" ");
      o.onInterim?.(text);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      robot.setState("idle");
      reject(new Error(`Speech recognition error: ${e.error}`));
    };
    rec.onend = () => resolve(text.trim());
    o.signal?.addEventListener("abort", () => rec.abort());
    rec.start();
  });
}
