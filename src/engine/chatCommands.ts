import type { ColorPart } from "./RobotAvatar";
import { STEP_METERS, type ActionResult, type GestureName, type RobotAction } from "./actions";
import type { EmotionName } from "./FaceController";

/**
 * Understands typed / spoken orders to the robot, in Arabic (Modern Standard and common dialect forms) and English,
 * entirely offline and instantly (no LLM): "تقدم مترين" "استدر يمينا 45 درجة" "اذهب إلى المكتب ثم لوّح" "take two steps back".
 * Anything it does not fully understand returns null, so the question goes to the LLM instead (which can still act
 * through [action=...] tags).
 */
export interface ParsedCommand {
  actions: RobotAction[];
  /** language of the user's text, for the confirmation */
  lang: "ar" | "en";
}

// ======================================================================= normalisation
const ASCII_DIGITS = (s: string) =>
  s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0));
/** light clean-up that keeps every letter (used when the original words must be spoken back) */
const soft = (s: string) => ASCII_DIGITS(s.normalize("NFKC")).toLowerCase().replace(/\s+/g, " ").trim();
/** pattern-friendly form: no diacritics/tatweel, one alef, ى→ي, ة→ه, punctuation → spaces */
export const norm = (s: string) =>
  soft(s)
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[؟?!.،,؛;:()"“”'«»…\-_/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const isArabic = (s: string) => /[؀-ۿ]/.test(s);
const W = (alts: string) => new RegExp(`(?:^| )(?:${alts})(?= |$)`);
const test = (re: RegExp, s: string) => re.test(s);

// ======================================================================= numbers
const WORD_NUM: Record<string, number> = {
  واحد: 1, واحده: 1, اثنين: 2, اثنان: 2, اثنتين: 2, ثنتين: 2, ثلاث: 3, ثلاثه: 3, تلات: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5,
  ست: 6, سته: 6, سبع: 7, سبعه: 7, ثمان: 8, ثمانيه: 8, تمان: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10, عشرين: 20, ثلاثين: 30, اربعين: 40,
  خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تسعين: 90, ميه: 100, مايه: 100, مئه: 100, مائه: 100, مئتين: 200, نصف: 0.5, ربع: 0.25, ثلث: 0.33,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, ninety: 90, hundred: 100, half: 0.5, quarter: 0.25, a: 1, an: 1,
};
/** value of a run of number tokens like ["خمسه","واربعين"] (= 45) or ["two"]; null if the first token is not a number */
function numberAt(tokens: string[], i: number): { value: number; len: number } | null {
  const t0 = tokens[i];
  if (t0 === undefined) return null;
  if (/^\d+(?:\.\d+)?$/.test(t0)) return { value: Number(t0), len: 1 };
  let value = 0, len = 0;
  for (let k = i; k < tokens.length; k++) {
    const raw = tokens[k];
    const t = len > 0 && raw.startsWith("و") && !(raw in WORD_NUM) ? raw.slice(1) : raw;
    const v = WORD_NUM[t];
    if (v === undefined) break;
    value += v;
    len++;
  }
  return len ? { value, len } : null;
}

const UNIT_M = new Set(["متر", "امتار", "مترا", "متره", "meter", "meters", "metre", "metres", "m"]);
const UNIT_CM = new Set(["سم", "سنتي", "سنتيمتر", "سنتيمترات", "cm", "centimeter", "centimeters"]);
const UNIT_STEP = new Set(["خطوه", "خطوات", "خطوتين", "step", "steps", "pace", "paces"]);
const UNIT_DEG = new Set(["درجه", "درجات", "درجتين", "degree", "degrees", "deg"]);
const DUALS: Record<string, number> = { مترين: 2, خطوتين: 2, درجتين: 2, سنتيمترين: 2 };

/** distance in metres from "two meters" / "٣ أمتار" / "مترين" / "خطوتين" / "نصف متر" / "متر ونصف"; undefined if none */
function parseDistance(tokens: string[]): number | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const unit: "m" | "cm" | "step" | null = UNIT_M.has(t) || t === "مترين" ? "m" : UNIT_CM.has(t) ? "cm" : UNIT_STEP.has(t) ? "step" : null;
    if (!unit) continue;
    let n: number | undefined = DUALS[t];
    if (n === undefined) {
      // number before the unit (1-3 tokens), or "متر ونصف" after it
      for (let back = 3; back >= 1 && n === undefined; back--) {
        const r = i - back >= 0 ? numberAt(tokens, i - back) : null;
        if (r && r.len === back) n = r.value;
      }
      if (n === undefined) n = t === "m" || UNIT_M.has(t) || UNIT_STEP.has(t) ? 1 : undefined;
      if (n === undefined) continue;
      const after = tokens[i + 1];
      if (after === "ونصف" || after === "و نصف" || (after === "and" && tokens[i + 2] === "half")) n += 0.5;
    }
    if (n === undefined) continue;
    return unit === "m" ? n : unit === "cm" ? n / 100 : n * STEP_METERS;
  }
  return undefined;
}
/** angle in degrees from "٩٠ درجة" / "ثلاثين درجة" / "ربع دورة" / "نصف دورة" / "45 degrees"; undefined if none */
function parseAngle(tokens: string[], text: string): number | undefined {
  if (/(?:^| )(?:ربع دوره|quarter turn)(?= |$)/.test(text)) return 90;
  if (/(?:^| )(?:نصف دوره|half turn|half circle)(?= |$)/.test(text)) return 180;
  if (/(?:^| )(?:دوره كامله|دوره|full turn|full circle|360)(?= |$)|حول نفسك|around yourself/.test(text) && !/ربع|نصف|دورتين/.test(text)) return 360;
  if (/دورتين|two turns/.test(text)) return 720;
  for (let i = 0; i < tokens.length; i++) {
    if (!UNIT_DEG.has(tokens[i]) && tokens[i] !== "°") continue;
    const d = DUALS[tokens[i]];
    if (d) return d;
    for (let back = 3; back >= 1; back--) {
      const r = i - back >= 0 ? numberAt(tokens, i - back) : null;
      if (r && r.len === back) return r.value;
    }
  }
  const m = /(?:^| )(\d+(?:\.\d+)?)°/.exec(text);
  return m ? Number(m[1]) : undefined;
}

// ======================================================================= vocabulary
const FWD = W("امام|قدام|للامام|لقدام|للقدام|الامام|مستقيم|forward|forwards|ahead|straight|front");
const BACK = W("خلف|وراء|ورا|للخلف|لورا|للوراء|الخلف|الوراء|back|backward|backwards|behind");
const LEFT = W("يسار|يسارا|لليسار|اليسار|left");
const RIGHT = W("يمين|يمينا|لليمين|اليمين|right");
const UP = W("اعلي|فوق|لفوق|للاعلي|الاعلي|up|upward|upwards");
const DOWN = W("اسفل|تحت|لتحت|للاسفل|الاسفل|down|downward|downwards");
const SLOW = /ببطء|ببطيء|بهدوء|ببطئ|slow|slowly|gently/;
const FAST = /بسرعه|بسرع|اسرع|بخفه|quick|quickly|fast|hurry|rapidly/;

const MOVE_VERB = W("(?:ال)?تقدم|تقدمي|امش|امشي|(?:ال)?مشي|سر|سير|تحرك|تحركي|روح|اذهب|اذهبي|اتجه|توجه|اخطو|اخط|اخطي|ازحف|walk|move|go|step|advance|proceed|head|travel");
/** verbs that on their own (without a direction) are too vague to act on, unless the order is just that verb */
const VAGUE_VERB = W("روح|اذهب|اذهبي|اتجه|توجه|تحرك|تحركي|go|move|head|travel|proceed");
const TURN_VERB = W("استدر|استدير|استديري|لف|لفي|در|دور|دوري|انعطف|turn|rotate|spin|pivot");
const TURN_NOUN = /(?:^| )(?:ربع دوره|نصف دوره|دوره كامله|دورتين|quarter turn|half turn|full turn)(?= |$)/;
const LOOK_VERB = W("انظر|انظري|شوف|التفت|وجه نظرك|look|gaze|glance|watch");
const GOTO_VERB = W("اذهب|اذهبي|روح|امش|امشي|توجه|اتجه|تعال|اقترب|تقدم|go|walk|move|head|come|navigate|proceed|stand|stay");

const PLACES: Record<string, string[]> = {
  desk: ["مكتب", "استقبال", "الاستقبال", "desk", "reception"],
  window: ["نافذه", "شباك", "زجاج", "window", "glass"],
  bench: ["مقعد", "كنبه", "جلوس", "bench", "sofa", "couch", "seat"],
  center: ["وسط", "منتصف", "center", "centre", "middle"],
  plant: ["نبته", "شجره", "نبات", "plant", "tree"],
};
/** token -> place key, also when glued to ال / لل / ل / ب */
const PLACE_BY_TOKEN = new Map<string, string>();
for (const [k, words] of Object.entries(PLACES)) for (const w of words) PLACE_BY_TOKEN.set(w.replace(/^ال/, ""), k);
function placeIn(tokens: string[]): string | null {
  for (const raw of tokens) {
    for (const t of [raw, raw.replace(/^(?:لل|ال|ل|ب)/, ""), raw.replace(/^(?:لل|ال|ل|ب)ال/, "")]) {
      const k = PLACE_BY_TOKEN.get(t);
      if (k) return k;
    }
  }
  return null;
}

const COLORS: Record<string, string> = {
  ازرق: "#1f6fe0", احمر: "#e02424", اخضر: "#1fa84f", اصفر: "#f2c200", برتقالي: "#f78a2c", بنفسجي: "#7b3fe4", وردي: "#f06aa8",
  ابيض: "#f5f7fa", اسود: "#16181d", رمادي: "#8a93a3", ذهبي: "#c9a46a", فيروزي: "#19c3c3", سماوي: "#59d0ff", كحلي: "#0b1a45",
  blue: "#1f6fe0", red: "#e02424", green: "#1fa84f", yellow: "#f2c200", orange: "#f78a2c", purple: "#7b3fe4", pink: "#f06aa8",
  white: "#f5f7fa", black: "#16181d", gray: "#8a93a3", grey: "#8a93a3", gold: "#c9a46a", cyan: "#19c3c3", navy: "#0b1a45",
};
const COLOR_PART: [RegExp, ColorPart][] = [
  [W("سترت[هك]?|سترتك|الزي|زيك|القميص|البدله|بدلتك|الستره|uniform|vest|suit|shirt|jacket"), "uniform"],
  [W("العيون|عيون[كه]?|عينيك|eyes?"), "eyes"],
  [W("الاضاءه|الانوار|الضوء|اضاءتك|lights?|glow"), "light"],
  [W("الجسم|الهيكل|جسمك|body|shell"), "body"],
];

// ======================================================================= one segment
const POLITE = /^(?:(?:ممكن|لو سمحت|من فضلك|رجاء|الرجاء|يا روبوت|يا رازي|روبوت|رازي|هل|تستطيع|يمكنك|بامكانك|تقدر|ان|اريدك|اريد منك|ابغاك|ابي|ابغي منك|ارجو|لازم|والان|الان|هيا|يلا|طيب|حسنا|اوكي|please|could you|can you|would you|will you|i want you to|i would like you to|i'd like you to|go ahead and|robot|razi|okay|ok|now|just)\s+)+/;
const TRAILING = /\s+(?:لو سمحت|من فضلك|رجاء|شكرا|please|thanks|thank you|now|الان|مره اخري|again)$/;

function asGesture(name: GestureName): RobotAction { return { type: "gesture", name }; }
function asEmotion(name: EmotionName): RobotAction { return { type: "emotion", name }; }

function parseSegment(seg: string, original: string): RobotAction[] | null {
  let s = seg;
  for (let i = 0; i < 3; i++) s = s.replace(POLITE, "").replace(TRAILING, "");
  s = s.trim();
  if (!s) return null;
  if (/^(?:لا|ما|مو|لن|don t|dont|do not|never|no)(?: |$)/.test(s) || /^don'?t /.test(s)) return null; // prohibitions are not orders
  const tokens = s.split(" ");
  const speed = SLOW.test(s) ? 0.4 : FAST.test(s) ? 0.9 : undefined;

  // ---- stop
  if (/^(?:قف|توقف|وقف|اوقف|اثبت|كفايه|خلاص|بس|stop|halt|freeze|enough|hold on|wait)(?: (?:عن \S+|مكانك|هنا|moving|talking|please))*$/.test(s)) return [{ type: "stop" }];

  // ---- say / repeat (the original words, not the normalised ones)
  const say = /^(?:please\s+)?(?:قل|قولي|قول|كرر|ردد|say|repeat(?: after me)?)\s+(.+)$/i.exec(original.trim());
  if (say && !/^(?:لي|لنا|لهم|me|us|something|a |an |hello to|hi to)/i.test(say[1]) && !/^(?:hi|hello|goodbye|bye)$/i.test(say[1].trim()) && !/^(?:نعم|لا)$/.test(norm(say[1]))) {
    return [{ type: "say", text: say[1].trim() }];
  }

  // ---- home / come here
  if (/^(?:عد|ارجع|رجع|روح|اذهب|go back|return|come back|back)(?: الي| to)? (?:مكانك(?: الاصلي)?|المكان الاصلي|المكان|البدايه|نقطه البدايه|النقطه الاولي|موقعك|الوضع الاصلي|start|home|your place|where you were|original (?:position|place|spot)|starting (?:point|position))$/.test(s) || /^(?:عد|go home|return home)$/.test(s)) return [{ type: "home" }];
  if (/^(?:تعال|تعالي|اقترب|come|come here|come closer|come over|approach)(?: (?:هنا|الي|لعندي|عندي|الينا|اليا|اليّ|to me|closer|here|over here))*$/.test(s)) return [{ type: "goto", place: "front" }];

  // ---- go to a place
  const place = placeIn(tokens);
  if (place && test(GOTO_VERB, s) && !/point|اشر/.test(s)) return [{ type: "goto", place }];

  // ---- colour
  if (/(?:^| )(?:غير|بدل|اجعل|لون|خلي|change|make|set|paint|turn)(?= |$)/.test(s)) {
    const part = COLOR_PART.find(([re]) => re.test(s));
    const color = tokens.map((t) => COLORS[t] ?? COLORS[t.replace(/^(?:ال|لل|ل|ب)/, "")] ?? COLORS[t.replace(/ه$/, "")]).find(Boolean);
    if (part && color) return [{ type: "color", part: part[1], color }];
  }
  if (/(?:^| )(?:الالوان الاصليه|الوان الاصليه|reset colou?rs|original colou?rs|default colou?rs)(?= |$)/.test(s)) return [{ type: "resetColors" }];

  // ---- gestures and moods
  if (/^(?:ودع|ودعني|ودعهم|ودعنا|wave (?:good ?bye|bye)|say (?:good ?bye|bye)|bye bye)(?: .*)?$/.test(s) || /^قل (?:مع السلامه|وداعا)$/.test(s)) return [asGesture("goodbye")];
  if (/^(?:لوح|لوحي|سلم|حيي|حيّي|رحب|ارفع (?:يدك|ايدك|يدك اليمني)|wave|greet|say (?:hi|hello)|give (?:a |me a )?wave)(?: .*)?$/.test(s)) return [asGesture("greeting")];
  if (/^(?:انحني|انحن|احني(?: راسك| ظهرك)?|اركع|bow|take a bow|curtsy)(?: .*)?$/.test(s)) return [asGesture("bow")];
  if (/^(?:اهز|هز|حرك) راسك(?: .*)?$/.test(s) || /^(?:shake|nod)(?: your)? head/.test(s)) return [asGesture(/(?:^| )(?:لا|نفي|يمين ويسار|اعترض|no|shake)(?= |$)/.test(s) ? "shake" : "nod")];
  if (/^(?:اومي|اومئ|وافق|nod)(?: .*)?$/.test(s)) return [asGesture("nod")];
  if (/^(?:اعترض|ارفض|shake)(?: .*)?$/.test(s)) return [asGesture("shake")];
  if (/^(?:افرح|ابتهج|احتفل|اضحك|celebrate|cheer|laugh|rejoice)(?: .*)?$/.test(s)) return [asGesture("happy"), asEmotion("happy")];
  if (/^(?:ابتسم|ابتسمي|كن سعيدا|كوني سعيده|smile|be happy|look happy)(?: .*)?$/.test(s)) return [asEmotion("happy")];
  if (/^(?:احزن|كن حزينا|be sad|look sad)(?: .*)?$/.test(s)) return [asGesture("sad"), asEmotion("sad")];
  if (/^(?:تفاجا|اندهش|كن متفاجئا|اظهر الدهشه|be surprised|look surprised|act surprised)(?: .*)?$/.test(s)) return [asGesture("surprised")];
  if (/^(?:فكر|فكري|تفكر|كن متفكرا|think|ponder)(?: .*)?$/.test(s)) return [{ type: "think" }];
  if (/^(?:اغضب|كن غاضبا|be angry|look angry|get angry)(?: .*)?$/.test(s)) return [asEmotion("angry")];
  if (/^(?:كن فضوليا|be curious|look curious)(?: .*)?$/.test(s)) return [asEmotion("curious")];
  if (/^(?:اهدا|هدي نفسك|كن هادئا|relax|calm down|be calm|be neutral|neutral)(?: .*)?$/.test(s)) return [asEmotion("neutral")];
  if (/^(?:ارمش|رمش|blink)(?: .*)?$/.test(s)) return [{ type: "blink" }];
  if (/^(?:اغمز|wink)(?: .*)?$/.test(s)) return [{ type: "blink", side: "left" }];

  // ---- point
  if (/^(?:اشر|اشير|شير|وجه يدك|point|show)(?: |$)/.test(s)) {
    if (place) return [{ type: "point", target: { place } }];
    return [{ type: "point", target: test(LEFT, s) ? "left" : test(RIGHT, s) ? "right" : "forward" }];
  }

  // ---- look
  if (test(LOOK_VERB, s) && !test(TURN_VERB, s)) {
    const target = test(LEFT, s) ? "left" : test(RIGHT, s) ? "right" : test(UP, s) ? "up" : test(DOWN, s) ? "down" : test(FWD, s) ? "forward"
      : /(?:^| )(?:الي|لي|عيني|اليه|me|at me|user|camera|الكاميرا|الي عيني)(?= |$)/.test(s) || tokens.length <= 1 ? "user" : null;
    if (target) return [{ type: "look", target }];
    return null;
  }

  // ---- turn in place
  if (test(TURN_VERB, s) || TURN_NOUN.test(s)) {
    const around = test(BACK, s) || /around|حول نفسك|للخلف/.test(s);
    const deg = parseAngle(tokens, s);
    if (test(LEFT, s) || test(RIGHT, s)) {
      const a = deg ?? 90;
      return [{ type: "turn", deg: test(RIGHT, s) ? -a : a }];
    }
    if (deg === 360 || around) return [{ type: "turn", deg: deg ?? 180 }];
    if (deg !== undefined) return [{ type: "turn", deg }];
    return /^(?:استدر|استدير|استديري|لف|در|دور)$/.test(s) ? [{ type: "turn", deg: 180 }] : null; // bare "turn" is ambiguous: ask the LLM
  }

  // ---- move
  const retreat = /^(?:تراجع|تراجعي|step back|back up|retreat|ارجع|رجع|رجوع)(?: |$)/.test(s);
  const stepVerb = /(?:^| )(?:خطوه|خطوات|خطوتين|اخطو|step|steps)(?= |$)/.test(s);
  if (test(MOVE_VERB, s) || retreat || stepVerb || test(FWD, s) && tokens.length <= 3) {
    const dir = retreat || test(BACK, s) ? "back" : test(LEFT, s) ? "left" : test(RIGHT, s) ? "right" : "forward";
    const hasDir = retreat || test(BACK, s) || test(LEFT, s) || test(RIGHT, s) || test(FWD, s);
    const dist = parseDistance(tokens);
    if (!hasDir && dist === undefined && !stepVerb && test(VAGUE_VERB, s) && tokens.length > 1) return null; // "go to sleep", "move on to..." is not an order
    if (!hasDir && dist === undefined && !stepVerb && tokens.length > 4) return null;
    const meters = dist ?? (stepVerb ? STEP_METERS : 1);
    return [{ type: "move", dir, meters, speed }];
  }
  return null;
}

// ======================================================================= whole message
const SEPARATORS = /(?:^|\s)(?:ثم|بعدين|بعدها|وبعدها|وبعدين|وثم|بعد ذلك|بعد هيك|then|and then|after that|afterwards|next)(?=\s|$)|[,،؛;]|\s+-\s+/g;
const LEAD_VERBS = new Set(["تقدم", "امش", "سر", "تحرك", "روح", "اذهب", "اتجه", "توجه", "تعال", "تراجع", "ارجع", "عد", "استدر", "التفت", "لف", "در", "دور", "قف", "توقف", "وقف", "اوقف", "اثبت", "لوح", "سلم", "ودع", "رحب", "حيي", "انحني", "انحن", "اومي", "هز", "اهز", "اشر", "وجه", "انظر", "ابتسم", "اضحك", "احزن", "افرح", "تفاجا", "اندهش", "فكر", "اغضب", "ارمش", "اغمز", "غير", "بدل", "اجعل", "قل", "كرر", "اخطو", "wave", "walk", "go", "move", "turn", "stop", "come", "look", "point", "bow", "nod", "smile", "say", "step", "rotate", "spin", "back", "return", "greet", "shake", "blink", "wink", "think", "laugh", "advance", "forward", "change"]);

/** split "a and b" at conjunctions only where the next word starts another order */
function splitCompound(text: string): string[] {
  const parts = text.split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const words = p.split(" ");
    let cur: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const nw = norm(w);
      const glued = nw.startsWith("و") && nw.length > 2 && LEAD_VERBS.has(nw.slice(1));
      const sepAnd = (nw === "و" || nw === "and") && i + 1 < words.length && LEAD_VERBS.has(norm(words[i + 1]));
      if (cur.length && (glued || sepAnd)) {
        out.push(cur.join(" "));
        cur = glued ? [w.replace(/^و/, "")] : [];
        continue;
      }
      if (sepAnd) continue;
      cur.push(w);
    }
    if (cur.length) out.push(cur.join(" "));
  }
  return out;
}

/** longest order accepted locally (words): longer sentences are conversation, not commands */
const MAX_WORDS = 22;

/**
 * Parse a user message into robot actions, or null when it is not (entirely) an order we understand.
 * Examples: "تقدم مترين" · "استدر يمينا 45 درجة" · "اذهب إلى المكتب ثم لوّح" · "take two steps back and wave" · "قف".
 */
export function parseCommands(text: string): ParsedCommand | null {
  const t = soft(text);
  if (!t || t.split(" ").length > MAX_WORDS) return null;
  const segments = splitCompound(t);
  if (!segments.length || segments.length > 6) return null;
  const actions: RobotAction[] = [];
  for (const seg of segments) {
    const a = parseSegment(norm(seg), seg);
    if (!a) return null; // part of it is not an order: let the LLM deal with the whole message
    actions.push(...a);
  }
  return actions.length ? { actions, lang: isArabic(text) ? "ar" : "en" } : null;
}

// ======================================================================= wording of replies
const PLACE_AR: Record<string, string> = { desk: "المكتب", window: "النافذة", bench: "المقعد", center: "المنتصف", front: "هنا", plant: "النبتة" };
const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
const AR_DIR: Record<string, string> = { forward: "للأمام", back: "للخلف", left: "لليسار", right: "لليمين" };
const EN_DIR: Record<string, string> = { forward: "forward", back: "back", left: "left", right: "right" };

/** short description of an action, for the chat log ("تقدم 2 م") */
export function describeAction(a: RobotAction, lang: "ar" | "en"): string {
  const ar = lang === "ar";
  switch (a.type) {
    case "move": return ar ? `تحرّك ${AR_DIR[a.dir]} ${fmt(a.meters)} م` : `move ${EN_DIR[a.dir]} ${fmt(a.meters)} m`;
    case "turn": return ar ? `استدر ${a.deg >= 0 ? "يساراً" : "يميناً"} ${fmt(Math.abs(a.deg))}°` : `turn ${a.deg >= 0 ? "left" : "right"} ${fmt(Math.abs(a.deg))}°`;
    case "stop": return ar ? "توقف" : "stop";
    case "home": return ar ? "العودة إلى المكان الأصلي" : "go back to start";
    case "goto": return ar ? `اذهب إلى ${PLACE_AR[a.place] ?? a.place}` : `go to the ${a.place === "front" ? "front" : a.place}`;
    case "gesture": return ar ? `حركة: ${{ greeting: "تلويح", goodbye: "وداع", bow: "انحناء", nod: "إيماءة", shake: "هز الرأس", happy: "فرح", surprised: "دهشة", sad: "حزن" }[a.name]}` : `gesture: ${a.name}`;
    case "point": return ar ? "أشِر" : "point";
    case "look": return ar ? "انظر" : "look";
    case "emotion": return ar ? `تعبير: ${a.name}` : `emotion: ${a.name}`;
    case "think": return ar ? "تفكير" : "think";
    case "blink": return ar ? "رمش" : "blink";
    case "color": return ar ? `لون ${a.part}` : `colour ${a.part}`;
    case "resetColors": return ar ? "الألوان الأصلية" : "reset colours";
    case "say": return ar ? `قل: ${a.text}` : `say: ${a.text}`;
  }
}

const ACK_AR = ["حاضر", "تمام", "تم", "أبشر"];
const ACK_EN = ["Sure", "Okay", "Done", "On it"];
let ackIndex = 0;
/** one-word confirmation, rotating so it does not sound canned */
export const ackWord = (lang: "ar" | "en") => (lang === "ar" ? ACK_AR : ACK_EN)[ackIndex++ % 4];

/** what the robot says when something could not be done (null = nothing to say) */
export function failureMessage(r: ActionResult, lang: "ar" | "en"): string | null {
  if (r.ok || r.reason === "interrupted") return null;
  const ar = lang === "ar";
  if (r.reason === "blocked") {
    const m = r.moved !== undefined && r.moved > 0.15 ? fmt(r.moved) : null;
    if (r.action.type === "move") return ar ? (m ? `لا أستطيع المتابعة، هناك عائق. تحركت ${m} متراً فقط.` : "لا أستطيع التحرك في هذا الاتجاه، هناك عائق.") : (m ? `I can't go further, something is in the way. I only moved ${m} metres.` : "I can't move that way, something is in the way.");
    return ar ? "لم أستطع الوصول بالكامل، هناك عائق في الطريق." : "I couldn't get all the way there, something is in the way.";
  }
  if (r.reason === "unreachable") return ar ? "لا أستطيع الوصول إلى هناك." : "I can't get there.";
  return ar ? "لم أفهم هذا الأمر." : "I didn't understand that order.";
}

/** the list of things you can ask, for a help message */
export function commandHelp(lang: "ar" | "en"): string {
  return lang === "ar"
    ? "أستطيع تنفيذ: تقدم / تراجع (مثال: تقدم مترين، خطوتين للخلف) · استدر يميناً أو يساراً (مثال: استدر يميناً 45 درجة) · اذهب إلى المكتب أو النافذة أو المقعد · عد إلى مكانك · تعال · قف · لوّح · ودّع · انحنِ · أومئ · ابتسم · فكّر · انظر إلي أو يميناً أو يساراً · أشر إلى اليمين · غيّر لون السترة إلى الأزرق. ويمكنك جمعها: «اذهب إلى المكتب ثم لوّح»."
    : "I can: move forward / back (e.g. move two metres, take two steps back) · turn left or right (e.g. turn right 45 degrees) · go to the desk, window or bench · go back to your place · come here · stop · wave · say goodbye · bow · nod · smile · think · look at me / left / right · point left or right · change the uniform to blue. Combine them: \"go to the desk then wave\".";
}
