import type { Viseme, VisemeEvent } from "./visemes";

/**
 * Approximate grapheme -> viseme conversion for English and Arabic.
 *
 * This is NOT a phonetic dictionary: it maps spelling to mouth shapes with simple
 * rules (digraphs, silent final "e", Arabic harakat/shadda, implicit short vowels in
 * unvocalised Arabic). Its job is plausible, well-timed mouth shapes. For exact
 * alignment feed real phoneme/viseme timings from the TTS engine (see adapters.ts).
 */
export interface Unit {
  viseme: Viseme;
  /** articulation strength 0..1 */
  weight: number;
  /** relative duration in seconds at normal speaking rate */
  dur: number;
  kind: "vowel" | "consonant" | "pause";
}

const V = (viseme: Viseme, weight = 1, dur = 0.11): Unit => ({ viseme, weight, dur, kind: "vowel" });
const C = (viseme: Viseme, weight = 1, dur = 0.065): Unit => ({ viseme, weight, dur, kind: "consonant" });
const PAUSE = (dur: number): Unit => ({ viseme: "sil", weight: 0, dur, kind: "pause" });

const EN_VOWEL_LETTERS = "aeiouy";
const isLatin = (c: string) => /[a-z]/.test(c);
const isArabicLetter = (c: string) => /[ء-يٱ-ۓ]/.test(c);
const isHaraka = (c: string) => /[ً-ْٰ]/.test(c);

// ------------------------------------------------------------------ English
const EN_DI: Record<string, () => Unit[]> = {
  th: () => [C("TH", 1, 0.075)], sh: () => [C("CH", 1, 0.09)], ch: () => [C("CH", 1, 0.09)],
  ph: () => [C("FF")], ng: () => [C("kk", 0.7)], ck: () => [C("kk")], gh: () => [],
  qu: () => [C("kk"), V("U", 0.7, 0.07)], wh: () => [V("U", 0.7, 0.06)], kn: () => [C("nn")], wr: () => [C("RR")],
  ee: () => [V("I", 1, 0.15)], ea: () => [V("I", 0.9, 0.14)], oo: () => [V("U", 1, 0.15)], ou: () => [V("O", 0.9, 0.14)],
  ow: () => [V("O", 0.9, 0.14)], oa: () => [V("O", 1, 0.14)], ai: () => [V("E", 0.9, 0.14)], ay: () => [V("E", 0.9, 0.14)],
  ei: () => [V("E", 0.8, 0.13)], ie: () => [V("I", 0.8, 0.13)], au: () => [V("O", 0.9, 0.13)], aw: () => [V("O", 0.9, 0.13)],
  oi: () => [V("O", 0.9, 0.14)], oy: () => [V("O", 0.9, 0.14)], ew: () => [V("U", 0.8, 0.13)], ue: () => [V("U", 0.7, 0.12)],
  ui: () => [V("U", 0.7, 0.11)],
};

function englishWord(w: string): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  while (i < w.length) {
    const c = w[i];
    const two = w.slice(i, i + 2);
    if (EN_DI[two]) {
      out.push(...EN_DI[two]());
      i += 2;
      continue;
    }
    const next = w[i + 1] ?? "";
    const atEnd = i === w.length - 1;
    switch (c) {
      case "a": out.push(V("aa", 1)); break;
      case "e":
        // silent final e after a consonant in longer words ("make", "time")
        if (atEnd && w.length > 2 && !EN_VOWEL_LETTERS.includes(w[i - 1] ?? "a")) break;
        out.push(V("E", 0.75));
        break;
      case "i": out.push(V("I", 0.8)); break;
      case "o": out.push(V("O", 0.95)); break;
      case "u": out.push(next === "e" || atEnd ? V("U", 0.85) : V("aa", 0.55)); break;
      case "y": out.push(i === 0 ? C("I", 0.6, 0.05) : V("I", 0.7)); break;
      case "b": case "p": case "m": if (w[i - 1] !== c) out.push(C("PP", 1, 0.07)); break;
      case "f": case "v": out.push(C("FF")); break;
      case "d": case "t": if (w[i - 1] !== c) out.push(C("DD")); break;
      case "n": case "l": if (w[i - 1] !== c) out.push(C("nn")); break;
      case "s": case "z": if (w[i - 1] !== c) out.push(C("SS", 1, 0.08)); break;
      case "x": out.push(C("kk", 1, 0.05), C("SS", 1, 0.07)); break;
      case "j": out.push(C("CH")); break;
      case "r": out.push(C("RR", 0.9)); break;
      case "w": out.push(C("U", 0.7, 0.06)); break;
      case "c": out.push("eiy".includes(next) ? C("SS") : C("kk")); break;
      case "k": case "g": case "q": if (w[i - 1] !== c) out.push(C("kk")); break;
      case "h": break; // aspiration: no mouth shape of its own
      default:
        if (/[0-9]/.test(c)) out.push(V("aa", 0.7, 0.14));
    }
    i++;
  }
  return out;
}

// ------------------------------------------------------------------ Arabic
const AR_CONS: Record<string, Unit> = {};
const addC = (letters: string, u: Unit) => {
  for (const l of letters) AR_CONS[l] = u;
};
addC("بپم", C("PP", 1, 0.07));
addC("فڤ", C("FF"));
addC("ثذظ", C("TH", 1, 0.075));
addC("تدطض", C("DD"));
addC("نل", C("nn"));
addC("سصز", C("SS", 1, 0.08));
addC("شجچژ", C("CH", 1, 0.09));
addC("كقکگغخ", C("kk"));
addC("هحع", C("aa", 0.45, 0.07)); // pharyngeal/glottal: mouth slightly open
addC("ر", C("RR", 0.9));
addC("ةۃ", V("aa", 0.4, 0.07));

function arabicWord(w: string): Unit[] {
  const out: Unit[] = [];
  const chars = [...w];
  const isCons = (c: string) => !!AR_CONS[c];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const nx = chars[i + 1] ?? "";
    const prevIsCons = i > 0 && isCons(chars[i - 1]);
    if (isHaraka(c)) {
      if (c === "َ") out.push(V("aa", 0.7, 0.08));
      else if (c === "ُ") out.push(V("U", 0.7, 0.08));
      else if (c === "ِ") out.push(V("I", 0.6, 0.08));
      else if (c === "ً") out.push(V("aa", 0.7, 0.08), C("nn", 1, 0.05));
      else if (c === "ٌ") out.push(V("U", 0.7, 0.08), C("nn", 1, 0.05));
      else if (c === "ٍ") out.push(V("I", 0.6, 0.08), C("nn", 1, 0.05));
      else if (c === "ّ") {
        for (let k = out.length - 1; k >= 0; k--) {
          if (out[k].kind === "consonant") {
            out[k].dur *= 1.8; // shadda: geminate the preceding consonant (vowel mark may sit in between)
            break;
          }
          if (out[k].kind === "pause") break;
        }
      }
      continue; // sukun / dagger alif: nothing extra
    }
    if ("اأإآٱ".includes(c)) {
      out.push(V("aa", c === "ا" && prevIsCons ? 1 : 0.85, c === "ا" && prevIsCons ? 0.15 : 0.1));
    } else if (c === "و" || c === "ؤ") {
      // consonant w at word start / before a vowel, long u elsewhere
      if (i === 0 || isHaraka(nx)) out.push(C("U", 0.7, 0.06));
      else out.push(V("U", 0.95, 0.15));
    } else if ("يىیئ".includes(c)) {
      if (i === 0 || isHaraka(nx)) out.push(C("I", 0.6, 0.06));
      else out.push(V("I", 0.9, 0.15));
    } else if (c === "ء" || c === "ـ") {
      continue;
    } else if (isCons(c)) {
      const u = { ...AR_CONS[c] };
      out.push(u);
      // unvocalised text: short implicit vowel between consonants
      const nxIsHaraka = isHaraka(nx);
      const nxIsLetter = isArabicLetter(nx);
      const nxVowelLetter = "اوي".includes(nx) && nx !== "";
      if (!nxIsHaraka && nxIsLetter && !nxVowelLetter && isCons(nx)) out.push(V("aa", 0.38, 0.05));
    }
  }
  return out;
}

// ------------------------------------------------------------------ text -> units
const PAUSE_MAP: Record<string, number> = {
  " ": 0.045, ",": 0.2, "،": 0.2, ";": 0.25, "؛": 0.25, ":": 0.22, ".": 0.36, "!": 0.36, "?": 0.38, "؟": 0.38,
  "…": 0.4, "\n": 0.35, "-": 0.06, "—": 0.15,
};

export function textToUnits(text: string): Unit[] {
  const units: Unit[] = [];
  const t = text.normalize("NFC").toLowerCase();
  let word = "";
  let wordKind: "en" | "ar" | null = null;
  const flush = () => {
    if (!word) return;
    units.push(...(wordKind === "ar" ? arabicWord(word) : englishWord(word)));
    word = "";
    wordKind = null;
  };
  for (const ch of t) {
    if (isLatin(ch) || /[0-9]/.test(ch) || ch === "'") {
      if (wordKind === "ar") flush();
      wordKind = "en";
      if (ch !== "'") word += ch;
    } else if (isArabicLetter(ch) || isHaraka(ch) || ch === "ـ") {
      if (wordKind === "en") flush();
      wordKind = "ar";
      word += ch;
    } else {
      flush();
      const p = PAUSE_MAP[ch];
      if (p !== undefined) {
        const last = units[units.length - 1];
        if (last && last.kind === "pause") last.dur = Math.max(last.dur, p);
        else units.push(PAUSE(p));
      }
    }
  }
  flush();
  return units;
}

export interface TimelineOptions {
  /** target total duration in seconds (e.g. the audio length). Units are scaled to fit. */
  totalDuration?: number;
  /** speaking rate multiplier when no totalDuration is given (1 = normal) */
  rate?: number;
  /** time offset added to every event */
  offset?: number;
}

/** Convert text to viseme events, optionally stretched to a known audio duration. */
export function textToVisemeEvents(text: string, o: TimelineOptions = {}): VisemeEvent[] {
  const units = textToUnits(text);
  if (!units.length) return [];
  let total = units.reduce((s, u) => s + u.dur, 0);
  let scale = 1 / (o.rate ?? 1);
  if (o.totalDuration && total > 0) scale = o.totalDuration / total;
  const events: VisemeEvent[] = [];
  let t = o.offset ?? 0;
  for (const u of units) {
    const d = u.dur * scale;
    events.push({ time: t, viseme: u.viseme, duration: d, weight: u.weight });
    t += d;
  }
  total *= scale;
  return events;
}

/** Estimated spoken duration of a text (seconds) at normal rate. */
export function estimateSpeechDuration(text: string, rate = 1) {
  return textToUnits(text).reduce((s, u) => s + u.dur, 0) / rate;
}
