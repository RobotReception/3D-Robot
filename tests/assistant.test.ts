import { describe, expect, it } from "vitest";
import { DirectiveParser, RobotAssistant, SentenceChunker, pcmEnvelope, type AssistantRobot, type ChatBackend, type TtsBackend } from "../src/engine/assistant";
import { buildSystemPrompt } from "../src/engine/assistantPrompt";
import type { VisemeEvent } from "../src/engine/lipsync/visemes";

describe("DirectiveParser", () => {
  const run = (chunks: string[]) => {
    const p = new DirectiveParser();
    const out = chunks.flatMap((c) => p.push(c)).concat(p.flush());
    return out.map((x) => (x.type === "text" ? x.text : `<${x.tag.name}=${x.tag.value}>`)).join("");
  };
  it("extracts emotion/gesture tags, also split across chunks, and never lets them reach the text", () => {
    expect(run(["[emotion=happy]Hello there."])).toBe("<emotion=happy>Hello there.");
    expect(run(["[emo", "tion=hap", "py] Hi [gesture=", "greeting]!"])).toBe("<emotion=happy> Hi <gesture=greeting>!");
    expect(run(["[Emotion: Curious]Really?"])).toBe("<emotion=curious>Really?");
  });
  it("swallows unknown directive values and keeps ordinary brackets as text", () => {
    expect(run(["[emotion=ecstatic]ok"])).toBe("ok");
    expect(run(["[gesture=backflip]ok"])).toBe("ok");
    expect(run(["see [1] and [note] here"])).toBe("see [1] and [note] here");
    expect(run(["unclosed [bracket at the end"])).toBe("unclosed [bracket at the end");
  });
});

describe("SentenceChunker", () => {
  const cut = (parts: string[]) => {
    const c = new SentenceChunker();
    return parts.flatMap((p) => c.push(p)).concat(c.flush());
  };
  it("cuts at sentence ends as text streams in, and the last sentence on flush", () => {
    expect(cut(["Welcome to the university. ", "How can I help you today? ", "Ask me anything you need!"])).toEqual([
      "Welcome to the university.", "How can I help you today? Ask me anything you need!", // short sentences are grouped for natural prosody
    ]);
    expect(cut(["Welcome to the university. ", "How can I help you with your enrolment today? ", "Ask me anything!"])).toEqual([
      "Welcome to the university.", "How can I help you with your enrolment today?", "Ask me anything!",
    ]);
    expect(cut(["Welcome to the univ", "ersity. How can", " I help you?"])).toEqual(["Welcome to the university.", "How can I help you?"]);
  });
  it("does not cut inside numbers or abbreviations, and joins very short first sentences", () => {
    expect(cut(["The fee is 3.5 million. Dr. Ali will help you. "])).toEqual(["The fee is 3.5 million.", "Dr. Ali will help you."]);
    expect(cut(["Hi. ", "I am Razi, your assistant at the university."])).toEqual(["Hi. I am Razi, your assistant at the university."]);
  });
  it("handles Arabic sentence ends and ellipses; long runs without punctuation are cut at a comma", () => {
    expect(cut(["أهلاً بك في جامعة الرازي. كيف أستطيع مساعدتك اليوم؟ "])).toEqual(["أهلاً بك في جامعة الرازي.", "كيف أستطيع مساعدتك اليوم؟"]);
    const long = "word ".repeat(30) + "and then, " + "more ".repeat(40);
    const parts = cut([long]);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 175)).toBe(true);
  });
});

describe("pcmEnvelope", () => {
  it("is 0..1, silent where the signal is silent", () => {
    const pcm = new Int16Array(2400);
    for (let i = 1200; i < 2400; i++) pcm[i] = Math.round(8000 * Math.sin(i * 0.2));
    const e = pcmEnvelope(pcm, 24000);
    expect(Math.max(...e.data)).toBeCloseTo(1, 5);
    expect(e.data[2]).toBe(0);
    expect(e.data[e.data.length - 5]).toBeGreaterThan(0.7);
  });
});

// ------------------------------------------------------------------ fake robot / backends
function fakeRobot() {
  const log: string[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const pcm: Int16Array[] = [];
  const visemes: VisemeEvent[][] = [];
  let streamsMade = 0, ended = false, pushed = 0;
  let finish: (() => void) | undefined;
  const robot: AssistantRobot = {
    setState: (s) => void log.push(`state:${s}`),
    setEmotion: (e) => void log.push(`emotion:${e}`),
    playAnimation: (n) => void log.push(`gesture:${n}`),
    speakStream: () => {
      streamsMade++;
      log.push("stream:start");
      const done = new Promise<void>((r) => (finish = r));
      return {
        pushPCM16: (c) => { pcm.push(c); pushed += c.length / 24000; },
        pushVisemes: (ev) => void visemes.push(ev),
        end: () => { ended = true; log.push("stream:end"); },
        stop: () => { log.push("stream:stop"); finish?.(); },
        time: () => now,
        finished: done,
      };
    },
    speak: (o) => { log.push(`speak:${o.text}`); return { finished: Promise.resolve(), stop: () => undefined }; },
    stopSpeech: () => { log.push("stopSpeech"); finish?.(); }, // like the real robot: stopping speech ends the stream
    after: (s, fn) => void timers.push({ at: now + s, fn }),
    defaultEmotion: "neutral",
  };
  /** advance robot time, running due timers */
  const advance = (sec: number) => {
    const end = now + sec;
    while (now < end) {
      now = Math.min(end, now + 0.02);
      for (const t of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
      if (ended && now >= pushed) finish?.(); // the audio has finished playing
    }
  };
  return { robot, log, pcm, visemes, advance, get streams() { return streamsMade; }, get ended() { return ended; }, get done() { return ended && now >= pushed; } };
}
const chatOf = (parts: string[], delayMs = 0): ChatBackend => ({
  async *stream(_req, signal) {
    for (const p of parts) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (signal.aborted) return;
      yield p;
    }
  },
});
/** 24 kHz tone, 0.1 s per 4 characters */
const toneTts = (calls: string[] = []): TtsBackend => ({
  sampleRate: 24000,
  async synth(text) {
    calls.push(text);
    const n = Math.max(2400, Math.round((text.length / 4) * 2400));
    const a = new Int16Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.round(9000 * Math.sin(i * 0.15));
    return a;
  },
});

describe("RobotAssistant", () => {
  it("thinks first, speaks the first sentence while the rest is generated, runs tags in time, returns to idle", async () => {
    const f = fakeRobot();
    const calls: string[] = [];
    const a = new RobotAssistant(f.robot, { chat: chatOf(["[gesture=greeting]Welcome to Al-Razi University. [emotion=curious]", "What would you like to know? I can help with admissions."], 5), tts: toneTts(calls) });
    const sentences: string[] = [];
    a.on("sentence", (e) => sentences.push(e.text));
    const p = a.ask("Hello");
    expect(f.log[0]).toBe("state:thinking"); // immediately, before any network
    // let TTS/stream start, then advance robot time while audio "plays"
    for (let i = 0; i < 200 && !f.done; i++) { await new Promise((r) => setTimeout(r, 5)); f.advance(0.1); }
    const res = await p;
    expect(res.aborted).toBe(false);
    expect(res.text).toBe("Welcome to Al-Razi University. What would you like to know? I can help with admissions.");
    expect(sentences).toEqual(["Welcome to Al-Razi University.", "What would you like to know?", "I can help with admissions."]);
    expect(calls).toEqual(sentences); // TTS got plain text (no tags), one request per sentence
    expect(f.streams).toBe(1); // ONE gapless stream for the whole answer
    expect(f.log).toContain("gesture:greeting");
    expect(f.log.indexOf("gesture:greeting")).toBeGreaterThan(f.log.indexOf("stream:start"));
    expect(f.log).toContain("emotion:curious");
    expect(f.log.at(-1)).toBe("emotion:neutral"); // restored at the end
    expect(a.history).toEqual([{ role: "user", text: "Hello" }, { role: "assistant", text: res.text }]);
    // visemes of later sentences are shifted by the audio already pushed
    const starts = f.visemes.map((v) => v[0].time);
    expect(starts[1]).toBeGreaterThan(f.pcm[0].length / 24000 - 0.01);
    expect(starts[2]).toBeGreaterThan(starts[1]);
    expect(f.visemes[0].some((e) => e.accent)).toBe(true); // prosody reaches the performer
  });

  it("prefetches: the next sentence is synthesised while the current one is still being prepared", async () => {
    const f = fakeRobot();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tts: TtsBackend = { sampleRate: 24000, async synth(text) { started.push(text); await gate; return new Int16Array(2400).fill(1000); } };
    const a = new RobotAssistant(f.robot, { chat: chatOf(["First sentence is long enough here. Second sentence is long enough here. Third sentence is long enough here."]), tts, prefetch: 2 });
    const p = a.ask("go");
    await new Promise((r) => setTimeout(r, 30));
    expect(started.length).toBe(2); // two in flight at once, the third waits for a slot
    release();
    for (let i = 0; i < 200 && !f.done; i++) { await new Promise((r) => setTimeout(r, 5)); f.advance(0.1); }
    await p;
    expect(started.length).toBe(3);
  });

  it("barge-in: a new question interrupts the running answer", async () => {
    const f = fakeRobot();
    const a = new RobotAssistant(f.robot, { chat: chatOf(["One sentence that is long enough. ", "Another sentence that is long enough. ", "A third one."], 30), tts: toneTts() });
    const first = a.ask("first");
    await new Promise((r) => setTimeout(r, 120));
    f.advance(0.3); // the first sentence is now playing
    const second = a.ask("second");
    const r1 = await first;
    expect(r1.aborted).toBe(true);
    expect(f.log).toContain("stopSpeech");
    for (let i = 0; i < 200 && !f.done; i++) { await new Promise((r) => setTimeout(r, 5)); f.advance(0.1); }
    const r2 = await second;
    expect(r2.aborted).toBe(false);
    expect(a.history.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["first", "second"]);
    // what the robot had already said before it was interrupted stays in the context, between the two questions
    const roles = a.history.map((m) => m.role).join(",");
    expect(roles.startsWith("user,assistant,user")).toBe(true);
    expect(a.history[1].text.length).toBeGreaterThan(5);
  });

  it("cancel() stops thinking and speaking and does not report an error", async () => {
    const f = fakeRobot();
    const a = new RobotAssistant(f.robot, { chat: chatOf(["Long answer one here. ", "Long answer two here."], 40), tts: toneTts() });
    const errors: string[] = [];
    a.on("error", (e) => errors.push(e.message));
    const p = a.ask("hi");
    await new Promise((r) => setTimeout(r, 20));
    a.cancel();
    expect((await p).aborted).toBe(true);
    expect(errors).toEqual([]);
  });

  it("a failing LLM puts the robot in its error state, keeps the history clean and reports the stage", async () => {
    const f = fakeRobot();
    const bad: ChatBackend = { async *stream() { throw new Error("HTTP 429: quota exceeded"); yield ""; } };
    const a = new RobotAssistant(f.robot, { chat: bad, tts: toneTts() });
    const errs: { message: string; stage: string }[] = [];
    a.on("error", (e) => errs.push(e));
    const r = await a.ask("hello");
    expect(r.error).toContain("429");
    expect(errs[0].stage).toBe("chat");
    expect(f.log).toContain("state:error");
    expect(a.history).toEqual([]);
    expect(a.thinking).toBe(false);
  });

  it("if TTS is down from the start the answer is still delivered with the browser voice", async () => {
    const f = fakeRobot();
    const tts: TtsBackend = { sampleRate: 24000, async synth() { throw new Error("tts offline"); } };
    const a = new RobotAssistant(f.robot, { chat: chatOf(["[emotion=happy]Good news. ", "Admissions are open."]), tts });
    const errs: string[] = [];
    a.on("error", (e) => errs.push(e.stage));
    const r = await a.ask("admissions?");
    expect(errs).toContain("tts");
    expect(f.log).toContain("speak:Good news. Admissions are open.");
    expect(f.log).toContain("emotion:happy");
    expect(r.text).toBe("Good news. Admissions are open.");
  });

  it("without a TTS backend the whole answer is collected and spoken once", async () => {
    const f = fakeRobot();
    const a = new RobotAssistant(f.robot, { chat: chatOf(["Hello", " there. ", "Nice to meet you."]) });
    const r = await a.ask("hi");
    expect(f.log.filter((l) => l.startsWith("speak:"))).toEqual(["speak:Hello there. Nice to meet you."]);
    expect(f.streams).toBe(0);
    expect(r.text).toBe("Hello there. Nice to meet you.");
  });

  it("history is trimmed and an empty question is ignored; the system prompt carries persona and the tag grammar", async () => {
    const f = fakeRobot();
    const a = new RobotAssistant(f.robot, { chat: chatOf(["Ok."]), maxHistory: 4, persona: { name: "Razi", organization: "Al-Razi University" } });
    expect((await a.ask("   ")).text).toBe("");
    for (let i = 0; i < 4; i++) await a.ask(`q${i}`);
    expect(a.history.length).toBeLessThanOrEqual(4);
    const sys = buildSystemPrompt({ name: "Razi", organization: "Al-Razi University", language: "ar" });
    expect(sys).toContain("Razi");
    expect(sys).toContain("Al-Razi University");
    expect(sys).toContain("[emotion=NAME]");
    expect(sys).toContain("[gesture=NAME]");
    expect(sys).toContain("Modern Standard Arabic");
    expect(a.systemPrompt).toContain("Al-Razi University");
  });
});
