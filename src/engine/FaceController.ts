import * as THREE from "three";

export type EmotionName =
  | "neutral" | "happy" | "sad" | "surprised" | "thinking" | "angry" | "curious" | "friendly" | "error";
export const EMOTIONS: EmotionName[] = ["neutral", "happy", "sad", "surprised", "thinking", "angry", "curious", "friendly", "error"];

export type EyeExpression = "neutral" | "happy" | "sad" | "angry" | "surprised" | "curious" | "squint" | "wide" | "closed";
export const EYE_EXPRESSIONS: EyeExpression[] = ["neutral", "happy", "sad", "angry", "surprised", "curious", "squint", "wide", "closed"];

/** key = morph name, optionally suffixed ".L" / ".R" to target one side (eyes/brows). */
type Weights = Record<string, number>;

const EMOTION_TABLE: Record<EmotionName, Weights> = {
  neutral: {},
  happy: { eyeHappy: 0.95, browUp: 0.25, mouthSmile: 1 },
  friendly: { eyeHappy: 0.4, browUp: 0.12, mouthSmile: 0.55 },
  sad: { eyeSad: 1, browInnerUp: 1, mouthFrown: 0.85 },
  surprised: { eyeSurprised: 1, browUp: 1, mouthSurprise: 0.95 },
  thinking: { eyeSquint: 0.35, "browUp.L": 0.7, "browDown.R": 0.45, "eyeCurious.L": 0.4, mouthFrown: 0.15 },
  angry: { eyeAngry: 1, browInnerDown: 1, browDown: 0.4, mouthFrown: 0.55 },
  curious: { eyeCurious: 1, "browUp.L": 0.85, "browUp.R": 0.2 },
  error: { eyeSad: 0.55, browInnerUp: 0.8, "browDown.R": 0.25, mouthFrown: 0.5 },
};
const EYE_TABLE: Record<EyeExpression, Weights> = {
  neutral: {},
  happy: { eyeHappy: 0.95 },
  sad: { eyeSad: 1 },
  angry: { eyeAngry: 1 },
  surprised: { eyeSurprised: 1 },
  curious: { eyeCurious: 1 },
  squint: { eyeSquint: 1 },
  wide: { eyeWide: 1 },
  closed: { eyeBlink: 1 },
};

const EYE_MORPHS = ["eyeBlink", "eyeSquint", "eyeWide", "eyeHappy", "eyeSad", "eyeAngry", "eyeSurprised", "eyeCurious"];
const BROW_MORPHS = ["browUp", "browDown", "browInnerUp", "browInnerDown"];
const MOUTH_EXPR = ["mouthSmile", "mouthFrown", "mouthSurprise"];
export const VISEME_MORPHS = [
  "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD", "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn",
  "viseme_RR", "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
];

export interface FaceMeshes {
  Eye_L: THREE.Mesh;
  Eye_R: THREE.Mesh;
  Mouth: THREE.Mesh;
  Brow_L: THREE.Mesh;
  Brow_R: THREE.Mesh;
}

/**
 * Drives every facial morph target. Compose order per frame:
 *   emotion preset (smoothed) -> eye-expression override -> blink -> speech (visemes) -> manual mouth.
 * Visemes never fight with expression morphs: while speaking, the expression's mouth
 * component is attenuated so e.g. a smile never stretches an "O".
 */
export class FaceController {
  private current = new Map<string, number>(); // "Mesh.morph" -> smoothed value
  private emotionName: EmotionName = "neutral";
  private emotionIntensity = 1;
  private eyeOverride: EyeExpression | null = null;
  /** seconds for expression changes to settle (~63%) */
  blendTime = 0.12;

  autoBlink = true;
  private nextBlink = 2 + Math.random() * 2;
  private blinkT = -1; // <0 idle, else progress seconds
  private manualBlinkQueued = false;
  blinkDuration = 0.22;

  private blinkL = 0;
  private blinkR = 0;
  private manualBlinkSide: "both" | "L" | "R" = "both";
  private blinkSide: "both" | "L" | "R" = "both";
  private visemes: Record<string, number> = {};
  private speaking = 0; // smoothed 0..1
  private speakingTarget = 0;
  private mouthOpen: number | null = null;
  private mouthOpenCur = 0;

  /** random source (tests inject a deterministic one) */
  rng: () => number = Math.random;

  constructor(private meshes: FaceMeshes) {
    for (const m of Object.values(meshes)) {
      if (!m.morphTargetInfluences) throw new Error(`${m.name} has no morph targets`);
    }
  }

  // ---- public control
  setEmotion(name: EmotionName, intensity = 1) {
    if (!(name in EMOTION_TABLE)) throw new Error(`Unknown emotion "${name}"`);
    this.emotionName = name;
    this.emotionIntensity = THREE.MathUtils.clamp(intensity, 0, 1);
  }
  get emotion() {
    return { name: this.emotionName, intensity: this.emotionIntensity };
  }
  setEyeExpression(name: EyeExpression | null) {
    if (name !== null && !(name in EYE_TABLE)) throw new Error(`Unknown eye expression "${name}"`);
    this.eyeOverride = name;
  }
  get eyeExpression() {
    return this.eyeOverride;
  }
  /** Blink both eyes, or wink one ("L" = the robot's left eye). */
  blink(side: "both" | "L" | "R" = "both") {
    this.manualBlinkQueued = true;
    this.manualBlinkSide = side;
  }
  /** null returns control of `mouthOpen` to speech/expressions */
  setMouthOpen(v: number | null) {
    this.mouthOpen = v === null ? null : THREE.MathUtils.clamp(v, 0, 1);
  }
  get mouthOpenValue() {
    return this.mouthOpenCur;
  }
  /** normalised viseme weights from the lip-sync controller (sum <= 1) */
  setVisemes(w: Record<string, number>) {
    this.visemes = w;
  }
  setSpeaking(on: boolean) {
    this.speakingTarget = on ? 1 : 0;
  }
  get speakingAmount() {
    return this.speaking;
  }
  /** Current value of a morph ("Mouth.viseme_aa"). */
  value(mesh: string, morph: string) {
    return this.current.get(`${mesh}.${morph}`) ?? 0;
  }

  // ---- frame
  update(dt: number) {
    const k = 1 - Math.exp(-dt / Math.max(0.01, this.blendTime));
    this.speaking += (this.speakingTarget - this.speaking) * (1 - Math.exp(-dt / 0.1));

    // blink
    let blink = 0;
    if (this.blinkT < 0) {
      this.nextBlink -= dt;
      if (this.manualBlinkQueued || (this.autoBlink && this.nextBlink <= 0)) {
        this.blinkT = 0;
        this.blinkSide = this.manualBlinkQueued ? this.manualBlinkSide : "both";
        this.manualBlinkQueued = false;
        this.nextBlink = 2.2 + this.rng() * 3.8;
        if (this.rng() < 0.15) this.nextBlink = 0.25; // occasional double blink
      }
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / this.blinkDuration;
      blink = p < 0.35 ? p / 0.35 : p < 0.5 ? 1 : 1 - (p - 0.5) / 0.5;
      if (p >= 1) {
        this.blinkT = -1;
        blink = 0;
      }
      blink = Math.max(0, Math.min(1, blink));
    }

    this.blinkL = this.blinkSide === "R" ? 0 : blink;
    this.blinkR = this.blinkSide === "L" ? 0 : blink;
    const emo = EMOTION_TABLE[this.emotionName];
    const eyeSrc = this.eyeOverride ? EYE_TABLE[this.eyeOverride] : emo;
    const attenuation = 1 - 0.6 * this.speaking;

    for (const side of ["L", "R"] as const) {
      const eye = `Eye_${side}`;
      const brow = `Brow_${side}`;
      for (const m of EYE_MORPHS) {
        // the blink envelope is applied after smoothing (in flush) so lids close at full speed
        this.approach(`${eye}.${m}`, this.pick(eyeSrc, m, side) * (this.eyeOverride ? 1 : this.emotionIntensity), k);
      }
      for (const m of BROW_MORPHS) {
        this.approach(`${brow}.${m}`, this.pick(emo, m, side) * this.emotionIntensity, k);
      }
    }
    for (const m of MOUTH_EXPR) {
      this.approach(`Mouth.${m}`, this.pick(emo, m, null) * this.emotionIntensity * attenuation, k);
    }
    // speech: faster tracking than expressions
    const kv = 1 - Math.exp(-dt / 0.035);
    for (const m of VISEME_MORPHS) {
      const key = `Mouth.${m}`;
      const tgt = this.visemes[m] ?? 0;
      this.current.set(key, (this.current.get(key) ?? 0) + (tgt - (this.current.get(key) ?? 0)) * kv);
    }
    const mo = this.mouthOpen ?? 0;
    this.mouthOpenCur += (mo - this.mouthOpenCur) * (1 - Math.exp(-dt / 0.05));
    this.current.set("Mouth.mouthOpen", this.mouthOpenCur);

    this.flush();
  }

  private pick(table: Weights, morph: string, side: "L" | "R" | null) {
    let v = table[morph] ?? 0;
    if (side) v = Math.max(v, table[`${morph}.${side}`] ?? 0);
    return v;
  }
  private approach(key: string, target: number, k: number) {
    const cur = this.current.get(key) ?? 0;
    this.current.set(key, cur + (target - cur) * k);
  }

  private flush() {
    for (const [key, v] of this.current) {
      const dot = key.indexOf(".");
      const meshName = key.slice(0, dot);
      const morph = key.slice(dot + 1);
      const mesh = (this.meshes as unknown as Record<string, THREE.Mesh>)[meshName];
      const idx = mesh.morphTargetDictionary?.[morph];
      if (idx === undefined) continue;
      let out = v;
      if (meshName.startsWith("Eye_")) {
        const b = meshName === "Eye_L" ? this.blinkL : this.blinkR;
        out = morph === "eyeBlink" ? Math.max(v, b) : v * (1 - b);
      }
      mesh.morphTargetInfluences![idx] = Math.min(1, Math.max(0, out));
    }
  }

  /** Snap all morphs to rest immediately (used by resetPose). */
  reset() {
    this.emotionName = "neutral";
    this.emotionIntensity = 1;
    this.eyeOverride = null;
    this.visemes = {};
    this.mouthOpen = null;
    this.speakingTarget = 0;
  }
}
