import { describe, expect, it } from "vitest";
import { ackWord, commandHelp, describeAction, failureMessage, norm, parseCommands } from "../src/engine/chatCommands";
import { parseActionTag, STEP_METERS, type RobotAction } from "../src/engine/actions";

const A = (text: string) => parseCommands(text)?.actions ?? null;
const move = (dir: string, meters: number, speed?: number): RobotAction => ({ type: "move", dir, meters, speed } as RobotAction);

describe("normalisation", () => {
  it("unifies Arabic spellings, digits and diacritics", () => {
    expect(norm("إلى الأمام؟")).toBe("الي الامام");
    expect(norm("٣ أمتار")).toBe("3 امتار");
    expect(norm("تَقَدَّمْ")).toBe("تقدم");
    expect(norm("المدرسة")).toBe("المدرسه");
  });
});

describe("move (Arabic and English)", () => {
  it.each([
    ["تقدم", [move("forward", 1)]],
    ["تقدم للأمام", [move("forward", 1)]],
    ["تقدم إلى الأمام مترين", [move("forward", 2)]],
    ["تقدّم 3 أمتار", [move("forward", 3)]],
    ["تقدم ٢ متر", [move("forward", 2)]],
    ["امش ثلاثة أمتار للأمام", [move("forward", 3)]],
    ["تقدم نصف متر", [move("forward", 0.5)]],
    ["تقدم متر ونصف", [move("forward", 1.5)]],
    ["تقدم 50 سم", [move("forward", 0.5)]],
    ["امش قدام", [move("forward", 1)]],
    ["خطوة للأمام", [move("forward", STEP_METERS)]],
    ["خذ خطوتين للخلف", [move("back", 2 * STEP_METERS)]],
    ["تراجع", [move("back", 1)]],
    ["تراجع خطوة", [move("back", STEP_METERS)]],
    ["ارجع للخلف مترين", [move("back", 2)]],
    ["ارجع ورا", [move("back", 1)]],
    ["تحرك لليمين متر", [move("right", 1)]],
    ["تحرك يسارا مترين", [move("left", 2)]],
    ["امش ببطء للأمام", [move("forward", 1, 0.4)]],
    ["تقدم بسرعة 4 أمتار", [move("forward", 4, 0.9)]],
    ["من فضلك تقدم للأمام", [move("forward", 1)]],
    ["هل تستطيع التقدم للأمام؟", [move("forward", 1)]],
    ["walk forward", [move("forward", 1)]],
    ["move forward 2 meters", [move("forward", 2)]],
    ["go forward two meters please", [move("forward", 2)]],
    ["take two steps back", [move("back", 2 * STEP_METERS)]],
    ["step back", [move("back", STEP_METERS)]],
    ["move left 3 metres", [move("left", 3)]],
    ["walk slowly forward", [move("forward", 1, 0.4)]],
    ["can you please go straight 5 meters", [move("forward", 5)]],
    ["forward", [move("forward", 1)]],
  ])("%s", (text, expected) => {
    expect(A(text)).toEqual(expected);
  });
});

describe("turn", () => {
  it.each([
    ["استدر يمينا", -90], ["استدر يمين", -90], ["استدر يسارا", 90], ["استدر لليسار", 90], ["استدر يميناً 45 درجة", -45],
    ["لف يسار ثلاثين درجة", 30], ["در لليمين خمس وأربعين درجة", -45], ["استدر للخلف", 180], ["استدر", 180], ["لف حول نفسك", 360],
    ["ربع دورة لليمين", -90], ["استدر نصف دورة", 180], ["turn right", -90], ["turn left 45 degrees", 45], ["turn around", 180],
    ["rotate right 30 degrees", -30], ["spin around", 180], ["turn right ninety degrees", -90], ["do a full turn", null],
  ] as [string, number | null][])("%s", (text, deg) => {
    const r = A(text);
    if (deg === null) return expect(r === null || r[0].type === "turn").toBe(true);
    expect(r).toEqual([{ type: "turn", deg }]);
  });
});

describe("places, stop, home", () => {
  it.each([
    ["اذهب إلى المكتب", { type: "goto", place: "desk" }], ["روح للمكتب", { type: "goto", place: "desk" }], ["امش إلى النافذة", { type: "goto", place: "window" }],
    ["اذهب إلى الاستقبال", { type: "goto", place: "desk" }], ["اذهب عند المقعد", { type: "goto", place: "bench" }], ["اذهب إلى المنتصف", { type: "goto", place: "center" }],
    ["go to the desk", { type: "goto", place: "desk" }], ["walk to the window", { type: "goto", place: "window" }], ["go to the bench", { type: "goto", place: "bench" }],
    ["تعال", { type: "goto", place: "front" }], ["تعال هنا", { type: "goto", place: "front" }], ["come here", { type: "goto", place: "front" }],
    ["قف", { type: "stop" }], ["توقف", { type: "stop" }], ["قف مكانك", { type: "stop" }], ["stop", { type: "stop" }], ["توقف عن الكلام", { type: "stop" }],
    ["عد إلى مكانك", { type: "home" }], ["ارجع إلى مكانك الأصلي", { type: "home" }], ["عد", { type: "home" }], ["go back to your place", { type: "home" }], ["go home", { type: "home" }],
  ] as [string, RobotAction][])("%s", (text, a) => {
    expect(A(text)).toEqual([a]);
  });
});

describe("gestures, moods, look, point, colours, say", () => {
  it.each([
    ["لوّح", [{ type: "gesture", name: "greeting" }]], ["سلّم", [{ type: "gesture", name: "greeting" }]], ["ارفع يدك", [{ type: "gesture", name: "greeting" }]],
    ["wave", [{ type: "gesture", name: "greeting" }]], ["wave your hand", [{ type: "gesture", name: "greeting" }]], ["say hi", [{ type: "gesture", name: "greeting" }]],
    ["ودّع", [{ type: "gesture", name: "goodbye" }]], ["wave goodbye", [{ type: "gesture", name: "goodbye" }]],
    ["انحنِ", [{ type: "gesture", name: "bow" }]], ["bow", [{ type: "gesture", name: "bow" }]],
    ["أومئ", [{ type: "gesture", name: "nod" }]], ["هز رأسك", [{ type: "gesture", name: "nod" }]], ["هز رأسك لا", [{ type: "gesture", name: "shake" }]], ["shake your head", [{ type: "gesture", name: "shake" }]],
    ["ابتسم", [{ type: "emotion", name: "happy" }]], ["smile", [{ type: "emotion", name: "happy" }]], ["افرح", [{ type: "gesture", name: "happy" }, { type: "emotion", name: "happy" }]],
    ["احزن", [{ type: "gesture", name: "sad" }, { type: "emotion", name: "sad" }]], ["فكّر", [{ type: "think" }]], ["think", [{ type: "think" }]],
    ["ارمش", [{ type: "blink" }]], ["wink", [{ type: "blink", side: "left" }]],
    ["انظر إليّ", [{ type: "look", target: "user" }]], ["look at me", [{ type: "look", target: "user" }]], ["انظر يمينا", [{ type: "look", target: "right" }]],
    ["التفت يسارا", [{ type: "look", target: "left" }]], ["look up", [{ type: "look", target: "up" }]], ["look left", [{ type: "look", target: "left" }]],
    ["أشر إلى اليمين", [{ type: "point", target: "right" }]], ["أشر لليسار", [{ type: "point", target: "left" }]], ["point left", [{ type: "point", target: "left" }]],
    ["أشر إلى المكتب", [{ type: "point", target: { place: "desk" } }]], ["point to the window", [{ type: "point", target: { place: "window" } }]],
    ["غيّر لون السترة إلى الأزرق", [{ type: "color", part: "uniform", color: "#1f6fe0" }]], ["غير لون العيون للأخضر", [{ type: "color", part: "eyes", color: "#1fa84f" }]],
    ["change the uniform to red", [{ type: "color", part: "uniform", color: "#e02424" }]], ["make the eyes purple", [{ type: "color", part: "eyes", color: "#7b3fe4" }]],
    ["reset colors", [{ type: "resetColors" }]],
    ["قل مرحبا بكم في جامعة الرازي", [{ type: "say", text: "مرحبا بكم في جامعة الرازي" }]], ["say welcome to the university", [{ type: "say", text: "welcome to the university" }]],
  ] as [string, RobotAction[]][])("%s", (text, expected) => {
    expect(A(text)).toEqual(expected);
  });
});

describe("compound orders", () => {
  it.each([
    ["تقدم مترين ثم استدر يمينا", [move("forward", 2), { type: "turn", deg: -90 }]],
    ["تقدم ولوّح", [move("forward", 1), { type: "gesture", name: "greeting" }]],
    ["اذهب إلى المكتب ثم لوّح ثم عد إلى مكانك", [{ type: "goto", place: "desk" }, { type: "gesture", name: "greeting" }, { type: "home" }]],
    ["استدر يسارا ثم تقدم 3 أمتار", [{ type: "turn", deg: 90 }, move("forward", 3)]],
    ["تقدم، ثم قف", [move("forward", 1), { type: "stop" }]],
    ["walk forward two meters and then turn left", [move("forward", 2), { type: "turn", deg: 90 }]],
    ["wave and walk forward", [{ type: "gesture", name: "greeting" }, move("forward", 1)]],
    ["go to the desk, then bow", [{ type: "goto", place: "desk" }, { type: "gesture", name: "bow" }]],
  ] as [string, RobotAction[]][])("%s", (text, expected) => {
    expect(A(text)).toEqual(expected);
  });
});

describe("NOT orders: left to the LLM", () => {
  it.each([
    "كيف أتقدم بطلب القبول؟", "ما هي شروط القبول؟", "لا تتقدم", "لا تمش", "don't move", "do not turn around", "never go there",
    "قل لي ما اسمك", "tell me a joke", "what do you do here", "hello", "مرحبا", "who are you", "اين المكتب؟", "متى يفتح الباب",
    "I want to go to sleep", "go to sleep", "the desk is nice", "هل المكتب قريب", "turn", "how do I walk to the library",
    "تقدم بطلب للتسجيل في الجامعة وارسل الاوراق المطلوبة الى القسم المختص قبل نهاية الشهر الحالي من فضلك", "", "   ",
  ])("%s", (text) => {
    expect(A(text)).toBeNull();
  });
  it("one unknown part makes the whole message conversation", () => {
    expect(A("تقدم ثم اشرح لي القبول")).toBeNull();
    expect(A("wave then tell me about admissions")).toBeNull();
  });
});

describe("language, wording and tags", () => {
  it("detects the language and words confirmations and failures", () => {
    expect(parseCommands("تقدم")!.lang).toBe("ar");
    expect(parseCommands("walk forward")!.lang).toBe("en");
    expect(ackWord("ar")).toMatch(/[ء-ي]/);
    expect(ackWord("en")).toMatch(/^[A-Z]/);
    const blocked = { action: move("forward", 5), ok: false, reason: "blocked", moved: 2.3, requested: 5 } as const;
    expect(failureMessage(blocked, "ar")).toContain("2.3");
    expect(failureMessage(blocked, "en")).toContain("2.3");
    expect(failureMessage({ action: move("forward", 1), ok: true }, "ar")).toBeNull();
    expect(failureMessage({ action: move("forward", 1), ok: false, reason: "interrupted" }, "ar")).toBeNull();
    expect(failureMessage({ action: { type: "goto", place: "desk" }, ok: false, reason: "unreachable" }, "en")).toContain("can't");
    expect(describeAction(move("forward", 2), "ar")).toBe("تحرّك للأمام 2 م");
    expect(describeAction({ type: "turn", deg: -45 }, "en")).toBe("turn right 45°");
    expect(commandHelp("ar").length).toBeGreaterThan(100);
  });
  it("parses [action=...] tags from an LLM and ignores bad ones", () => {
    expect(parseActionTag("forward:2")).toEqual({ type: "move", dir: "forward", meters: 2, speed: undefined });
    expect(parseActionTag("back")).toMatchObject({ type: "move", dir: "back", meters: 1 });
    expect(parseActionTag("forward:500")).toMatchObject({ meters: 6 }); // clamped
    expect(parseActionTag("turn_left:90")).toEqual({ type: "turn", deg: 90 });
    expect(parseActionTag("turn_right:45")).toEqual({ type: "turn", deg: -45 });
    expect(parseActionTag("goto:desk")).toEqual({ type: "goto", place: "desk" });
    expect(parseActionTag("goto:moon")).toBeNull();
    expect(parseActionTag("look:user")).toEqual({ type: "look", target: "user" });
    expect(parseActionTag("point:window")).toEqual({ type: "point", target: { place: "window" } });
    expect(parseActionTag("stop")).toEqual({ type: "stop" });
    expect(parseActionTag("explode")).toBeNull();
    expect(parseActionTag("color:eyes:00ff00")).toEqual({ type: "color", part: "eyes", color: "#00ff00" });
    expect(parseActionTag("color:eyes:notahex")).toBeNull();
  });
});
