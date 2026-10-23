import { armPose, fingerPose, headPose, HAND_PRESETS, type RawPose } from "./rig";
import { merge, smooth, type ClipDef, type PoseFrame } from "./clips";

/**
 * Built-in motion library. Every clip is a pure function of time that is baked into
 * THREE.AnimationClips (per channel) at registration. Add your own with
 * `robot.animation.register({...})` - see docs/ANIMATION.md.
 *
 * Angles are authored through the semantic helpers (armPose/headPose/fingerPose) so
 * left/right mirroring and sign conventions stay consistent.
 */

const TAU = Math.PI * 2;
const w = (t: number, period: number, phase = 0) => Math.sin(TAU * (t / period) + phase);
const REL = HAND_PRESETS.relaxed;
const hands = (c = REL, c2 = c): RawPose => merge(fingerPose("L", c), fingerPose("R", c2));
const arms = (l: Parameters<typeof armPose>[1], r: Parameters<typeof armPose>[1]) => merge(armPose("L", l), armPose("R", r));
const env = (t: number, d: number, up: number, down: number) => smooth(t / up) * smooth((d - t) / down);

const idle: ClipDef = {
  name: "idle", duration: 12, loop: true, priority: 0, fadeIn: 0.6, fadeOut: 0.6,
  description: "Natural standing: breathing, weight shift, micro head and arm motion.",
  pose: (t) => ({
    joints: merge(
      {
        chest: [0.9 * w(t, 4), 0, 0],
        spine: [0.5 * w(t, 4, 0.6), 1.2 * w(t, 12, 0.4), 0],
        pelvis: [0, 0, 1.2 * w(t, 12)],
        neck: [-0.8 * w(t, 6, 0.3), 1.8 * w(t, 12, 1), 0.5 * w(t, 12, 2)],
        head: [-1.2 * w(t, 6, 0.8), 3 * w(t, 12, 1.2), 1.0 * w(t, 12, 2.2)],
      },
      arms(
        { shoulder: 3 + 1.2 * w(t, 4, 0.2), abduction: 7 + 0.8 * w(t, 6), elbow: 10 + 1.5 * w(t, 6, 1) },
        { shoulder: 3 + 1.2 * w(t, 4, 1.4), abduction: 7 + 0.8 * w(t, 6, 2), elbow: 10 + 1.5 * w(t, 6, 3) },
      ),
      hands(),
    ),
    pelvis: [0.006 * w(t, 12), 0.0025 * w(t, 4), 0],
  }),
};

const listening: ClipDef = {
  name: "listening", duration: 6, loop: true, priority: 1, fadeIn: 0.55, fadeOut: 0.5,
  description: "Attentive: slight lean toward the user, head tilt and slow nodding.",
  pose: (t) => ({
    joints: merge(
      {
        spine: [4, 0, 0], chest: [3, 0, 0], neck: [2, 0, 0],
        head: [...headPose({ roll: 7 + 1.2 * w(t, 6), pitch: 2 + 3 * Math.max(0, w(t, 3)) ** 2 })] as [number, number, number],
      },
      arms({ shoulder: 10, abduction: 9, elbow: 30 }, { shoulder: 12, abduction: 9, elbow: 34 }),
      hands(),
    ),
    pelvis: [0, 0, 0.012],
  }),
};

const thinking: ClipDef = {
  name: "thinking", duration: 6, loop: true, priority: 1, fadeIn: 0.6, fadeOut: 0.5,
  description: "Hand-to-chin pose, head tilted and turned away.",
  pose: (t) => ({
    joints: merge(
      {
        spine: [2, 0, 0],
        head: [...headPose({ roll: 9 + 1.5 * w(t, 6), pitch: 7 + 1.5 * w(t, 3), yaw: -14 + 3 * w(t, 6, 1) })] as [number, number, number],
        neck: [0, -4, 0],
      },
      armPose("R", { shoulder: 44, abduction: -17, elbow: 107 + 2 * w(t, 3), twist: -36, wristFlex: -4 + 4 * w(t, 3) }),
      armPose("L", { shoulder: 22, abduction: 6, elbow: 78, twist: 0 }),
      fingerPose("R", HAND_PRESETS.point),
      fingerPose("L", HAND_PRESETS.relaxed),
    ),
  }),
};

const talkR: ClipDef = {
  name: "talkR", duration: 6.4, loop: true, priority: 3, fadeIn: 1.1, fadeOut: 0.8, channels: ["armR", "fingersR"],
  description: "Light right-hand speech gesture.",
  pose: (t) => ({
    joints: merge(
      armPose("R", {
        shoulder: 22 + 7 * w(t, 3.2), abduction: 15 + 3 * w(t, 6.4), elbow: 68 + 14 * w(t, 3.2, 1.2),
        twist: 12 * w(t, 6.4), wristFlex: 8 * w(t, 1.6),
      }),
      fingerPose("R", { thumb: 0.1, index: 0.1, middle: 0.2, ring: 0.25 }),
    ),
  }),
};
const talkL: ClipDef = {
  name: "talkL", duration: 6, loop: true, priority: 3, fadeIn: 1.1, fadeOut: 0.8, channels: ["armL", "fingersL"],
  description: "Light left-hand speech gesture.",
  pose: (t) => ({
    joints: merge(
      armPose("L", {
        shoulder: 14 + 5 * w(t, 3, 2), abduction: 13 + 2 * w(t, 6), elbow: 52 + 10 * w(t, 3, 0.4),
        twist: -8 * w(t, 6, 1), wristFlex: 5 * w(t, 1.5, 1),
      }),
      fingerPose("L", { thumb: 0.15, index: 0.15, middle: 0.25, ring: 0.3 }),
    ),
  }),
};

const wave = (t: number, d: number, freq: number, amp: number, lift = 1, ramp = 0.55): RawPose => {
  const e = env(t, d, ramp, ramp);
  const swing = e * amp * w(t, 1 / freq);
  return merge(
    armPose("R", { shoulder: 10 * e, abduction: 78 * e * lift, twist: 78 * e, elbow: (96 + swing) * e }),
    fingerPose("R", HAND_PRESETS.open, 6 * e),
  );
};

const greeting: ClipDef = {
  name: "greeting", duration: 3, loop: false, priority: 6, fadeIn: 0.38, fadeOut: 0.5,
  channels: ["armR", "fingersR", "head", "torso"],
  description: "Friendly raised-hand wave with a welcoming head tilt.",
  pose: (t) => {
    const e = env(t, 3, 0.85, 0.85); // unhurried raise and lower
    return {
      joints: merge(
        wave(t, 3, 1.9, 24, 1, 0.85),
        { spine: [2 * e, 0, 0], head: [...headPose({ pitch: 5 * e, roll: 6 * e })] as [number, number, number] },
      ),
      pelvis: [0, -0.008 * e, 0],
    };
  },
};

const goodbye: ClipDef = {
  name: "goodbye", duration: 3.6, loop: false, priority: 6, fadeIn: 0.38, fadeOut: 0.6,
  channels: ["armR", "fingersR", "head", "torso"],
  description: "Slow farewell wave finishing with a small bow.",
  pose: (t) => {
    const e = env(t, 3.6, 0.5, 0.7);
    const bow = smooth((t - 2.2) / 0.5) * smooth((3.4 - t) / 0.5);
    return {
      joints: merge(
        wave(t, 3.6, 1.4, 20, 0.95),
        { spine: [14 * bow, 0, 0], chest: [8 * bow, 0, 0], head: [...headPose({ pitch: -10 * bow + 4 * e, roll: 4 * e })] as [number, number, number] },
      ),
    };
  },
};

const pointing: ClipDef = {
  name: "pointing", duration: 2.6, loop: false, priority: 8, fadeIn: 0.3, fadeOut: 0.45,
  channels: ["armR", "fingersR", "head"],
  description: "Right arm extended forward-right, index finger extended.",
  pose: (t) => {
    const e = env(t, 2.6, 0.5, 0.6);
    return {
      joints: merge(
        armPose("R", { shoulder: 78 * e, abduction: 12 * e, elbow: 6 * e, wristFlex: 0 }),
        fingerPose("R", { thumb: 0.7 * e, index: 0, middle: e, ring: e }),
        { head: [...headPose({ yaw: -14 * e, pitch: 3 * e })] as [number, number, number] },
      ),
    };
  },
};

const happy: ClipDef = {
  name: "happy", duration: 2.2, loop: false, priority: 6, fadeIn: 0.38, fadeOut: 0.55,
  description: "Cheerful bounce with arms raised.",
  pose: (t) => {
    const e = env(t, 2.2, 0.4, 0.5);
    const b = 0.5 + 0.5 * Math.sin(TAU * 2.2 * t - Math.PI / 2);
    return {
      joints: merge(
        arms({ shoulder: 150 * e, abduction: 30 * e, elbow: 14 * e + 10 * e * b }, { shoulder: 150 * e, abduction: 30 * e, elbow: 14 * e + 10 * e * b }),
        hands({ thumb: 0, index: 0, middle: 0, ring: 0 }),
        { head: [...headPose({ pitch: 9 * e, roll: 7 * e * w(t, 1.1) })] as [number, number, number], spine: [-3 * e, 0, 0] },
      ),
      pelvis: [0, -0.045 * e * (1 - b), 0],
    };
  },
};

const sad: ClipDef = {
  name: "sad", duration: 3.4, loop: false, priority: 6, fadeIn: 0.5, fadeOut: 0.8,
  description: "Head and shoulders drop, slow sigh.",
  pose: (t) => {
    const e = env(t, 3.4, 0.9, 1.0);
    return {
      joints: merge(
        {
          clavicle_L: [0, 0, -12 * e], clavicle_R: [0, 0, 12 * e],
          spine: [7 * e, 0, 0], chest: [4 * e, 0, 0], neck: [4 * e, 0, 0],
          head: [...headPose({ pitch: -11 * e + 1.5 * e * w(t, 2.2), roll: 4 * e })] as [number, number, number],
        },
        arms({ shoulder: 6 * e, abduction: 4, elbow: 16 * e }, { shoulder: 6 * e, abduction: 4, elbow: 16 * e }),
        hands({ thumb: 0.2, index: 0.3, middle: 0.35, ring: 0.4 }),
      ),
      pelvis: [0, -0.018 * e, 0],
    };
  },
};

const surprised: ClipDef = {
  name: "surprised", duration: 1.8, loop: false, priority: 6, fadeIn: 0.1, fadeOut: 0.5,
  description: "Quick recoil with raised open hands.",
  pose: (t) => {
    const e = env(t, 1.8, 0.14, 0.6);
    const settle = 1 - 0.25 * smooth((t - 0.14) / 0.4);
    return {
      joints: merge(
        arms({ shoulder: 12 * e, abduction: 34 * e, elbow: 48 * e * settle }, { shoulder: 12 * e, abduction: 34 * e, elbow: 48 * e * settle }),
        hands({ thumb: 0, index: 0, middle: 0, ring: 0 }, { thumb: 0, index: 0, middle: 0, ring: 0 }),
        { spine: [-6 * e * settle, 0, 0], head: [...headPose({ pitch: 9 * e * settle })] as [number, number, number], clavicle_L: [0, 0, 8 * e], clavicle_R: [0, 0, -8 * e] },
      ),
      pelvis: [0, 0, -0.012 * e],
    };
  },
};

const error: ClipDef = {
  name: "error", duration: 2.2, loop: false, priority: 6, fadeIn: 0.15, fadeOut: 0.5,
  description: "Apologetic shrug with a head shake.",
  pose: (t) => {
    const e = env(t, 2.2, 0.3, 0.6);
    const shake = e * 16 * w(t, 0.55) * smooth((1.7 - t) / 0.4);
    return {
      joints: merge(
        {
          clavicle_L: [0, 0, 16 * e], clavicle_R: [0, 0, -16 * e],
          head: [...headPose({ yaw: shake, pitch: -4 * e, roll: 4 * e })] as [number, number, number],
          spine: [-2 * e, 0, 0],
        },
        arms({ shoulder: 14 * e, abduction: 28 * e, elbow: 64 * e, wrist: -35 * e }, { shoulder: 14 * e, abduction: 28 * e, elbow: 64 * e, wrist: -35 * e }),
        hands({ thumb: 0.05, index: 0.05, middle: 0.1, ring: 0.1 }),
      ),
    };
  },
};

const nod: ClipDef = {
  name: "nod", duration: 1.2, loop: false, priority: 5, fadeIn: 0.1, fadeOut: 0.25, channels: ["head"],
  description: "Two small head nods (acknowledge).",
  pose: (t) => ({ joints: { head: [14 * Math.sin(TAU * 1.7 * t) * smooth((1.2 - t) / 0.3) * smooth(t / 0.08), 0, 0] } }),
};
const shake: ClipDef = {
  name: "shake", duration: 1.2, loop: false, priority: 5, fadeIn: 0.1, fadeOut: 0.25, channels: ["head"],
  description: "Head shake (disagree).",
  pose: (t) => ({ joints: { head: [0, 20 * Math.sin(TAU * 2 * t) * smooth((1.2 - t) / 0.3) * smooth(t / 0.08), 0] } }),
};
const bow: ClipDef = {
  name: "bow", duration: 2.4, loop: false, priority: 6, fadeIn: 0.3, fadeOut: 0.5, channels: ["torso", "head"],
  description: "Polite bow.",
  pose: (t) => {
    const e = env(t, 2.4, 0.8, 0.8);
    return { joints: { spine: [18 * e, 0, 0], chest: [10 * e, 0, 0], head: [8 * e, 0, 0] }, pelvis: [0, 0, -0.03 * e] };
  },
};

export const BUILTIN_CLIPS: ClipDef[] = [
  idle, listening, thinking, talkR, talkL, greeting, goodbye, pointing, happy, sad, surprised, error, nod, shake, bow,
];

/** Animation names exposed by `robot.playAnimation` (adds the locomotion pseudo-clips). */
export const LOCOMOTION_ANIMATIONS = ["walking", "turning"] as const;

/** Emotion that accompanies an animation by default (can be disabled per call). */
export const ANIMATION_EMOTION: Record<string, string> = {
  happy: "happy", sad: "sad", surprised: "surprised", error: "error", greeting: "friendly", goodbye: "friendly",
  thinking: "thinking", listening: "friendly",
};

export type { PoseFrame };
