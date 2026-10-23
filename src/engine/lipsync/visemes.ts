/**
 * Viseme set: the 15 "Oculus/OVR" visemes (also used by Ready Player Me etc.), so
 * morph targets and external tools map 1:1. `sil` = mouth at rest.
 */
export const VISEMES = [
  "sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U",
] as const;
export type Viseme = (typeof VISEMES)[number];

export interface VisemeEvent {
  /** seconds from the start of the utterance */
  time: number;
  viseme: Viseme;
  /** seconds; defaults to "until the next event" */
  duration?: number;
  /** 0..1 articulation strength (1 = full) */
  weight?: number;
  /** 0..1 lexical stress carried by this vowel (text-derived). Drives head nods, brow raises and hand beats. */
  accent?: number;
  /** punctuation that ends a phrase: on the pause event, or (`endMark`) on the last event before an aligned pause */
  mark?: string;
  endMark?: string;
}

export const visemeMorph = (v: Viseme) => `viseme_${v}`;

/**
 * Azure Speech viseme IDs (0..21) -> our set. Azure's table groups several phonemes per
 * ID; this mapping follows the documented groups (verify against the current Azure docs
 * if you depend on exact shapes).
 */
export const AZURE_VISEME_MAP: Viseme[] = [
  "sil", // 0 silence
  "aa", // 1 æ ə ʌ
  "aa", // 2 ɑ
  "O", // 3 ɔ
  "E", // 4 ɛ ʊ
  "RR", // 5 ɝ
  "I", // 6 j i ɪ
  "U", // 7 w u
  "O", // 8 o
  "aa", // 9 aʊ
  "O", // 10 ɔɪ
  "aa", // 11 aɪ
  "kk", // 12 h
  "RR", // 13 ɹ
  "nn", // 14 l
  "SS", // 15 s z
  "CH", // 16 ʃ tʃ dʒ ʒ
  "TH", // 17 ð
  "FF", // 18 f v
  "DD", // 19 d t n θ
  "kk", // 20 k g ŋ
  "PP", // 21 p b m
];

/** Rhubarb Lip Sync mouth cues (A-H, X) -> viseme. */
export const RHUBARB_MAP: Record<string, Viseme> = {
  A: "PP", B: "kk", C: "E", D: "aa", E: "O", F: "U", G: "FF", H: "nn", X: "sil",
};

/** How wide each viseme opens, used to scale amplitude-driven articulation. */
export const VISEME_OPENNESS: Record<Viseme, number> = {
  sil: 0, PP: 0, FF: 0.25, TH: 0.4, DD: 0.4, kk: 0.45, CH: 0.45, SS: 0.2, nn: 0.3, RR: 0.4,
  aa: 1, E: 0.65, I: 0.35, O: 0.8, U: 0.55,
};
