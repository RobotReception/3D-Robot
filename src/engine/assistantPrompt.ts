import { EMOTIONS, type EmotionName } from "./FaceController";

/** Emotions an LLM may request with `[emotion=NAME]` (all robot emotions except the internal "error"). */
export const ASSISTANT_EMOTIONS: EmotionName[] = EMOTIONS.filter((e) => e !== "error");
/** One-shot gestures an LLM may request with `[gesture=NAME]` (they play on top of the speaking pose). */
export const ASSISTANT_GESTURES = ["greeting", "goodbye", "pointing", "nod", "shake", "bow", "happy", "surprised"] as const;
export type AssistantGesture = (typeof ASSISTANT_GESTURES)[number];

export interface PromptOptions {
  /** the robot's name */
  name?: string;
  /** who it works for, e.g. "Al-Razi University" */
  organization?: string;
  /** its job, e.g. "reception assistant" */
  role?: string;
  /** "auto" = the user's language; or force "ar" / "en" */
  language?: "auto" | "ar" | "en";
  /** answer length limit in sentences */
  maxSentences?: number;
  /** extra rules / knowledge (opening hours, FAQ...) appended verbatim */
  extra?: string;
}

/**
 * System prompt for an LLM that speaks through the robot. It teaches the model to answer briefly in spoken language,
 * to use punctuation that the robot's head/hands/brows follow, and to steer emotion/gestures with inline tags that
 * `RobotAssistant` strips before speaking.
 */
export function buildSystemPrompt(o: PromptOptions = {}): string {
  const name = o.name ?? "Razi";
  const org = o.organization ? ` at ${o.organization}` : "";
  const role = o.role ?? "reception assistant";
  const max = o.maxSentences ?? 3;
  const lang =
    o.language === "ar" ? "Always answer in clear Modern Standard Arabic."
      : o.language === "en" ? "Always answer in English."
        : "Answer in the language the user writes in (Arabic or English). For Arabic use clear Modern Standard Arabic unless the user clearly writes a dialect.";
  return [
    `You are ${name}, a friendly, professional ${role}${org}. You speak out loud through a 3D robot character.`,
    lang,
    `Keep answers short: at most ${max} sentences, about 40 words, unless the user asks for more detail. Start with the answer itself, no filler.`,
    "Write plain spoken text only: no markdown, bullet lists, headings, emojis, URLs or stage directions in asterisks. Write numbers and dates the way they are spoken.",
    "Use normal punctuation (commas, full stops, question marks, exclamation marks): the robot nods, raises its eyebrows and gestures on them.",
    `You may start a sentence with at most two control tags that animate the robot. They are never spoken. Emotion: [emotion=NAME] with NAME one of ${ASSISTANT_EMOTIONS.join(", ")}. Gesture: [gesture=NAME] with NAME one of ${ASSISTANT_GESTURES.join(", ")}. Put a tag only at the very beginning of a sentence, never inside one.`,
    "Typical use: [gesture=greeting] when greeting, [gesture=goodbye] when saying goodbye, [emotion=happy] for good news, [emotion=curious] before asking the user a question, [emotion=sad] when apologising or giving bad news, [gesture=pointing] when giving directions. Most sentences need no tag.",
    "If you do not know something, say so briefly and offer what you can do. Never invent facts about the organisation.",
    o.extra ? o.extra : "",
  ].filter(Boolean).join("\n");
}
