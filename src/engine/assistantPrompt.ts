import { LOBBY_PLACES } from "./actions";
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
  /** let the model move the robot with [action=...] tags (default true); pass the place names it may send the robot to */
  actions?: boolean | { places?: string[] };
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
    `You may start a sentence with at most three control tags that animate the robot. They are never spoken. Emotion: [emotion=NAME] with NAME one of ${ASSISTANT_EMOTIONS.join(", ")}. Gesture: [gesture=NAME] with NAME one of ${ASSISTANT_GESTURES.join(", ")}. Put a tag only at the very beginning of a sentence, never inside one.`,
    "Typical use: [gesture=greeting] when greeting, [gesture=goodbye] when saying goodbye, [emotion=happy] for good news, [emotion=curious] before asking the user a question, [emotion=sad] when apologising or giving bad news, [gesture=pointing] when giving directions. Most sentences need no tag.",
    ...(o.actions === false ? [] : [actionRules(typeof o.actions === "object" ? o.actions.places : undefined)]),
    "If you do not know something, say so briefly and offer what you can do. Never invent facts about the organisation.",
    o.extra ? o.extra : "",
  ].filter(Boolean).join("\n");
}

function actionRules(places = Object.keys(LOBBY_PLACES)): string {
  return [
    `You can also move the robot with [action=...] tags, placed at the start of a sentence like the others (never spoken, the move starts when that sentence is spoken): [action=forward:2] [action=back:1] [action=left:1] [action=right:1] (metres), [action=turn_left:90] [action=turn_right:90] (degrees), [action=goto:PLACE] with PLACE one of ${places.join(", ")}, [action=home] (back to your starting spot), [action=look:user|left|right|up|down|forward], [action=point:left|right|forward|PLACE].`,
    "Use them only when the user asks you to move or show something, or when you guide a visitor (for example [action=goto:desk] together with \"Please follow me to the reception desk.\"). Never move on your own otherwise, and never claim to have moved without a tag. Plain orders like \"move forward\" are normally handled before they reach you.",
  ].join(" ");
}
