import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { AnimationController, type PlayOptions, type PlayResult } from "./AnimationController";
import { AudioController, speakWithBrowserTTS, speechSynthesisAvailable, type LoadedAudio, type PlayingAudio, type PcmStream } from "./AudioController";
import { applyLimbIK, limbRest, setClampedDelta, type LimbDef, type LimbRest } from "./ik";
import type { Channel } from "./clips";
import { Emitter } from "./events";
import { FaceController, type EmotionName, type EyeExpression } from "./FaceController";
import { GazeController } from "./GazeController";
import { JointOverrides } from "./JointOverrides";
import { ANIMATION_EMOTION, BUILTIN_CLIPS } from "./library";
import { LipSyncController } from "./lipsync/LipSyncController";
import { activeIntervals, alignTextToActivity } from "./lipsync/align";
import { estimateSpeechDuration, textToVisemeEvents } from "./lipsync/phonemizer";
import type { VisemeEvent } from "./lipsync/visemes";
import { inspectRobotModel, loadRobotGLTF, type LoadOptions, type RobotModelParts } from "./loader";
import { LocomotionController, type WalkOptions } from "./LocomotionController";
import {
  HAND_PRESETS, JOINT_DEFS, JointSpace, armPose, clampEuler, eulerToQuat, fingerPose, headPose, parseBone, rawLimits,
  type ArmAngles, type EulerDeg, type FingerCurl, type HeadAngles, type Side,
} from "./rig";
import { AssistantStateMachine, type AssistantState } from "./stateMachine";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type RobotEvents = {
  "animation:start": { name: string; channels: Channel[] };
  "animation:end": { name: string; channel?: Channel };
  "animation:blocked": { name: string; channels?: Channel[] };
  emotion: { name: EmotionName; intensity: number };
  state: { from: AssistantState; to: AssistantState };
  "speech:start": { text?: string; mode: string; duration?: number };
  "speech:end": { interrupted: boolean };
  "walk:start": { x: number; z: number };
  "walk:end": { arrived: boolean };
  command: { cmd: string; ok: boolean; error?: string };
  error: { message: string };
};

export interface AnimationHandle extends PlayResult {
  /** resolves when every accepted channel finished (never for looping clips until stopped) */
  finished: Promise<void>;
}

export interface SpeakOptions {
  /** URL of an audio file to play */
  audioUrl?: string;
  /** already-decoded audio (e.g. from a file picker) */
  audio?: LoadedAudio;
  /** text to speak / to derive visemes from */
  text?: string;
  /** BCP-47 language for TTS ("en-US", "ar-SA"). Language of the *text* is auto-detected for visemes. */
  lang?: string;
  /** drive the mouth (default true) */
  lipSync?: boolean;
  /** viseme timings from your TTS engine (preferred over text/audio analysis) */
  visemes?: VisemeEvent[];
  emotion?: EmotionName;
  /** hand gestures while talking (default true) */
  gestures?: boolean;
  /** speak with the browser's speechSynthesis when no audio is given (default true) */
  tts?: boolean;
  /** speaking rate multiplier for TTS / silent preview */
  rate?: number;
  /** keep the emotion after speech (default: restore the previous one) */
  keepEmotion?: boolean;
}
export interface SpeechHandle {
  finished: Promise<void>;
  stop(): void;
  mode: "audio" | "tts" | "silent";
}

export interface StreamSpeechOptions {
  sampleRate?: number;
  emotion?: EmotionName;
  gestures?: boolean;
}
export interface StreamSpeechHandle {
  pushPCM16(chunk: ArrayBuffer | Int16Array): void;
  /** external viseme timings relative to stream start (otherwise the mouth follows the live audio) */
  pushVisemes(events: VisemeEvent[]): void;
  end(): void;
  stop(): void;
  finished: Promise<void>;
}

export interface RobotAvatarOptions {
  clips?: typeof BUILTIN_CLIPS;
  autoBlink?: boolean;
  idleGaze?: boolean;
  /** deterministic random source (tests) */
  rng?: () => number;
}

const DEG = Math.PI / 180;
const ARM_DEF = (s: Side): LimbDef => ({ upper: `upperarm_${s}`, lower: `forearm_${s}`, end: `hand_${s}` });

interface Reach {
  target: THREE.Vector3 | null; // world
  handLength: number;
  weight: number;
  goal: number;
  hold: number | null;
}

/**
 * RobotAvatar - the engine facade. Owns the model and every controller, and exposes the
 * public control API (animations, emotions, joints, speech, locomotion, state machine,
 * JSON commands). It has no dependency on a UI: use it from any three.js app, R3F, or headless.
 */
export class RobotAvatar extends Emitter<RobotEvents> {
  /** add this to your scene. Moving/rotating it moves the robot (locomotion drives it). */
  readonly root = new THREE.Group();
  readonly model: THREE.Group;
  readonly parts: RobotModelParts;
  readonly joints: JointSpace;
  readonly animation: AnimationController;
  readonly face: FaceController;
  readonly lipsync: LipSyncController;
  readonly gaze: GazeController;
  readonly overrides: JointOverrides;
  readonly locomotion: LocomotionController;
  readonly stateMachine: AssistantStateMachine;
  audio: AudioController | null = null;

  time = 0;
  private reach: Record<Side, Reach> = {
    L: { target: null, handLength: 0.13, weight: 0, goal: 0, hold: null },
    R: { target: null, handLength: 0.13, weight: 0, goal: 0, hold: null },
  };
  private reachRest: Record<Side, LimbRest>;
  private speech: { token: number; stop: () => void } | null = null;
  private speechToken = 0;
  private glowBase = new Map<THREE.Material, { color: THREE.Color; intensity: number }>();
  private glowBoost = 0;

  constructor(parts: RobotModelParts, opts: RobotAvatarOptions = {}) {
    super();
    this.parts = parts;
    this.model = parts.scene;
    this.root.name = "RobotAvatar";
    this.root.add(this.model);
    this.joints = new JointSpace(this.root);
    this.animation = new AnimationController(this.joints);
    this.animation.registerAll(opts.clips ?? BUILTIN_CLIPS);
    this.animation.onEvent = (type, info) => {
      if (type === "play") this.emit("animation:start", { name: info.name, channels: info.channels ?? [] });
      else if (type === "end") this.emit("animation:end", { name: info.name, channel: info.channel });
      else this.emit("animation:blocked", { name: info.name, channels: info.channels });
    };
    const m = parts.meshes;
    this.face = new FaceController({
      Eye_L: m.get("Eye_L")!, Eye_R: m.get("Eye_R")!, Mouth: m.get("Mouth")!, Brow_L: m.get("Brow_L")!, Brow_R: m.get("Brow_R")!,
    });
    if (opts.rng) this.face.rng = opts.rng;
    this.face.autoBlink = opts.autoBlink ?? true;
    this.lipsync = new LipSyncController(this.face);
    this.gaze = new GazeController(this.joints);
    this.gaze.idleWander = opts.idleGaze ?? true;
    if (opts.rng) this.gaze.rng = opts.rng;
    this.overrides = new JointOverrides(this.joints);
    this.locomotion = new LocomotionController(this.joints, this.root);
    this.reachRest = { L: limbRest(this.joints, ARM_DEF("L")), R: limbRest(this.joints, ARM_DEF("R")) };
    this.stateMachine = new AssistantStateMachine(this);
    for (const name of ["Mat_Glow", "Mat_Face"]) {
      const mat = parts.materials.get(name) as THREE.MeshStandardMaterial | undefined;
      if (mat) this.glowBase.set(mat, { color: mat.emissive.clone(), intensity: mat.emissiveIntensity });
    }
    this.animation.play("idle", { fadeIn: 0.01 });
    this.update(0.016);
  }

  static async load(url: string, opts: RobotAvatarOptions & LoadOptions = {}): Promise<RobotAvatar> {
    return RobotAvatar.fromGLTF(await loadRobotGLTF(url, opts), opts);
  }
  static fromGLTF(gltf: GLTF, opts: RobotAvatarOptions = {}): RobotAvatar {
    return new RobotAvatar(inspectRobotModel(gltf), opts);
  }

  // ================================================================ frame
  update(dt: number) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    const j = this.joints;
    // bones that no clip channel resets
    j.resetBone("eye_L");
    j.resetBone("eye_R");

    this.animation.update(dt);
    this.applyBehaviors(dt);
    const head = j.bone("head").getWorldPosition(new THREE.Vector3());
    this.gaze.update(dt, head);
    this.locomotion.update(dt);
    this.updateReach(dt);
    this.overrides.apply(dt);
    this.lipsync.update(dt);
    this.face.update(dt);
    this.updateGlow(dt);
    this.stateMachine.update(dt);
    this.updateWalkEvents();
    if (this.timers.length) {
      const due: (() => void)[] = [];
      this.timers = this.timers.filter((tm) => {
        tm.t -= dt;
        if (tm.t <= 0) due.push(tm.fn);
        return tm.t > 0;
      });
      due.forEach((f) => f());
    }
  }

  private timers: { t: number; fn: () => void }[] = [];
  /** Run `fn` after `seconds` of *robot time* (advances with update(), so it is deterministic in tests). */
  after(seconds: number, fn: () => void) {
    this.timers.push({ t: seconds, fn });
  }
  /** Promise that resolves after `seconds` of robot time. */
  delay(seconds: number): Promise<void> {
    return new Promise((res) => this.after(seconds, res));
  }

  private walkWasBusy = false;
  private updateWalkEvents() {
    const busy = this.locomotion.state !== "idle";
    if (this.walkWasBusy && !busy) this.emit("walk:end", { arrived: true });
    this.walkWasBusy = busy;
  }

  private applyBehaviors(dt: number) {
    void dt;
    const j = this.joints;
    const q = new THREE.Quaternion();
    // speaking: head bobs with articulation energy
    const e = this.lipsync.energy;
    if (e > 0.02) {
      const s = Math.sin(this.time * Math.PI * 2 * 2.1);
      j.applyDelta("head", eulerToQuat({ x: -2.2 * e * s, y: 1.4 * e * Math.sin(this.time * 1.7), z: 0.9 * e * Math.sin(this.time * 2.9) }, "YXZ", q));
    }
    // walking: counter-swinging arms + torso twist, only on arms that are not gesturing
    const sw = this.locomotion.gaitSwing();
    if (sw.amount > 0.02) {
      for (const [side, v] of [["L", sw.armL], ["R", sw.armR]] as const) {
        const owner = this.animation.ownerOf(`arm${side}` as Channel);
        if ((owner?.priority ?? 0) <= 1 && this.reach[side].weight < 0.05 && !this.overrides.has(`upperarm_${side}`)) {
          j.applyDelta(`upperarm_${side}`, eulerToQuat({ x: -v, y: 0, z: 0 }, "XZY", q));
          j.applyDelta(`forearm_${side}`, eulerToQuat({ x: -Math.abs(v) * 0.5 - 6 * sw.amount, y: 0, z: 0 }, "XZY", q));
        }
      }
      j.applyDelta("spine", eulerToQuat({ x: sw.lean, y: sw.spineYaw, z: 0 }, "YXZ", q));
    }
  }

  private updateReach(dt: number) {
    const c = this.root;
    const j = this.joints;
    for (const side of ["L", "R"] as Side[]) {
      const r = this.reach[side];
      if (r.hold !== null) {
        r.hold -= dt;
        if (r.hold <= 0) {
          r.goal = 0;
          r.hold = null;
          if (r.target) this.releaseHand(side);
        }
      }
      r.weight += Math.sign(r.goal - r.weight) * Math.min(Math.abs(r.goal - r.weight), dt / 0.4);
      if (r.weight <= 0.001 || !r.target) {
        if (r.goal === 0) r.target = r.weight > 0.001 ? r.target : null;
        continue;
      }
      c.updateMatrixWorld(true);
      const def = ARM_DEF(side);
      const sh = j.bone(def.upper).getWorldPosition(new THREE.Vector3());
      c.worldToLocal(sh);
      const tgt = c.worldToLocal(r.target.clone());
      const dir = tgt.clone().sub(sh).normalize();
      const wrist = tgt.clone().addScaledVector(dir, -r.handLength);
      const m = side === "L" ? 1 : -1;
      const pole = new THREE.Vector3(m * 0.55, -1, -0.15).normalize();
      const w = r.weight * r.weight * (3 - 2 * r.weight);
      applyLimbIK(j, def, this.reachRest[side], sh, wrist, pole, j.worldDelta(`clavicle_${side}`), w);
      setClampedDelta(j, `hand_${side}`, new THREE.Quaternion(), w);
    }
  }

  private updateGlow(dt: number) {
    this.glowBoost += (0 - this.glowBoost) * (1 - Math.exp(-dt / 0.3));
    const pulse = 1 + 0.35 * this.lipsync.energy + this.glowBoost;
    for (const [mat, base] of this.glowBase) {
      (mat as THREE.MeshStandardMaterial).emissiveIntensity = base.intensity * (mat.name === "Mat_Glow" ? pulse : 1);
    }
  }

  // ================================================================ animations
  /** Play a clip ("greeting", "happy", ...) or locomotion ("walking", "turning"). */
  playAnimation(name: string, opts: PlayOptions & { emotion?: boolean } = {}): AnimationHandle {
    if (name === "walking") {
      this.locomotion.walkForward(0.7);
      this.emit("animation:start", { name, channels: [] });
      return { name, accepted: [], rejected: [], finished: Promise.resolve() };
    }
    if (name === "turning") {
      const p = this.locomotion.turnBy(90);
      this.emit("animation:start", { name, channels: [] });
      return { name, accepted: [], rejected: [], finished: p.then(() => undefined) };
    }
    if (!this.animation.has(name)) throw new Error(`Unknown animation "${name}". Available: ${this.listAnimations().join(", ")}`);
    const res = this.animation.play(name, opts);
    if (res.accepted.length && opts.emotion !== false && ANIMATION_EMOTION[name]) {
      this.face.setEmotion(ANIMATION_EMOTION[name] as EmotionName);
      const def = this.animation.def(name)!;
      if (!def.loop) this.after((def.duration * 0.85) / Math.max(0.1, this.animation.speed), () => this.maybeRestoreEmotion(name));
    }
    const finished = new Promise<void>((resolve) => {
      if (!res.accepted.length) return resolve();
      const left = new Set(res.accepted);
      const off = this.on("animation:end", (e) => {
        if (e.name === name && e.channel) left.delete(e.channel);
        if (!left.size) {
          off();
          resolve();
        }
      });
    });
    return { ...res, finished };
  }
  private maybeRestoreEmotion(anim: string) {
    if (!this.animation.isPlaying(anim) || this.speech) return;
    if (this.stateMachine.state === "idle" && ANIMATION_EMOTION[anim] === this.face.emotion.name) this.face.setEmotion("neutral");
  }
  stopAnimation(name?: string) {
    if (name === "walking" || name === "turning") return this.locomotion.stop();
    this.animation.stop(name);
  }
  listAnimations(): string[] {
    return [...this.animation.list().map((d) => d.name), "walking", "turning"];
  }
  /** global animation speed multiplier */
  setSpeed(multiplier: number) {
    this.animation.speed = Math.max(0, multiplier);
  }

  // ================================================================ face
  setEmotion(name: EmotionName, intensity = 1) {
    this.face.setEmotion(name, intensity);
    this.emit("emotion", { name, intensity });
  }
  setEyeExpression(name: EyeExpression | null) {
    this.face.setEyeExpression(name);
  }
  setMouthOpen(value: number | null) {
    this.face.setMouthOpen(value);
  }
  blink() {
    this.face.blink();
  }
  setGlow(color?: THREE.ColorRepresentation, boost = 0) {
    for (const [mat, base] of this.glowBase) {
      if (mat.name === "Mat_Glow") (mat as THREE.MeshStandardMaterial).emissive.set(color ?? base.color);
    }
    this.glowBoost = boost;
  }
  setEyeColor(color: THREE.ColorRepresentation) {
    for (const [mat] of this.glowBase) if (mat.name === "Mat_Face") (mat as THREE.MeshStandardMaterial).emissive.set(color);
  }

  // ================================================================ gaze
  /** Look at a world-space point, an Object3D, or `null` to release. */
  lookAt(target: Vec3 | THREE.Object3D | null) {
    if (!target) return this.gaze.setTarget(null);
    if ((target as THREE.Object3D).isObject3D) {
      const o = target as THREE.Object3D;
      this.gaze.setTarget(() => o.getWorldPosition(new THREE.Vector3()));
    } else {
      const t = target as Vec3;
      this.gaze.setTarget(new THREE.Vector3(t.x, t.y, t.z));
    }
  }

  /** Point the eyes (degrees) independently of the head; pass null to resume following the look-at target. */
  setEyeDirection(dir: { yaw?: number; pitch?: number } | null) {
    this.gaze.manualEyes = dir ? { yaw: dir.yaw ?? 0, pitch: dir.pitch ?? 0 } : null;
  }

  // ================================================================ direct joint control
  /** Semantic head pose in degrees (yaw + = left, pitch + = up, roll + = tilt left). */
  moveHead(a: HeadAngles, o: { fade?: number; hold?: number; smooth?: number } = {}) {
    // natural combined head+neck range
    a = {
      yaw: a.yaw === undefined ? undefined : THREE.MathUtils.clamp(a.yaw, -85, 85),
      pitch: a.pitch === undefined ? undefined : THREE.MathUtils.clamp(a.pitch, -50, 50),
      roll: a.roll === undefined ? undefined : THREE.MathUtils.clamp(a.roll, -45, 45),
    };
    const [x, y, z] = headPose(a);
    // distribute: head 65 %, neck 35 %
    const part = (k: number): Partial<EulerDeg> => ({
      ...(a.pitch !== undefined ? { x: x * k } : {}),
      ...(a.yaw !== undefined ? { y: y * k } : {}),
      ...(a.roll !== undefined ? { z: z * k } : {}),
    });
    this.overrides.set("head", part(0.65), o);
    this.overrides.set("neck", part(0.35), o);
  }
  /** Semantic arm angles in degrees. Only the given angles are overridden. */
  moveArm(side: "left" | "right" | Side, a: ArmAngles, o: { fade?: number; hold?: number; smooth?: number } = {}) {
    const s: Side = side === "left" || side === "L" ? "L" : "R";
    const pose = armPose(s, a);
    // armPose emits zeros for untouched axes of a bone; only forward axes that were requested
    const req: Record<string, Partial<EulerDeg>> = {};
    const up: Partial<EulerDeg> = {};
    if (a.shoulder !== undefined) up.x = pose[`upperarm_${s}`][0];
    if (a.twist !== undefined) up.y = pose[`upperarm_${s}`][1];
    if (a.abduction !== undefined) up.z = pose[`upperarm_${s}`][2];
    if (Object.keys(up).length) req[`upperarm_${s}`] = up;
    const fa: Partial<EulerDeg> = {};
    if (a.elbow !== undefined) fa.x = pose[`forearm_${s}`][0];
    if (a.wrist !== undefined) fa.y = pose[`forearm_${s}`][1];
    if (Object.keys(fa).length) req[`forearm_${s}`] = fa;
    if (a.wristFlex !== undefined) req[`hand_${s}`] = { x: pose[`hand_${s}`][0] };
    for (const [bone, ang] of Object.entries(req)) this.overrides.set(bone, ang, o);
    this.reach[s].goal = 0; // direct control cancels IK reach
  }
  /** Raw joint-space control of any bone (degrees, see docs/RIG.md). */
  moveJoint(bone: string, angles: Partial<EulerDeg>, o: { fade?: number; hold?: number; smooth?: number } = {}) {
    if (!this.joints.has(bone)) throw new Error(`Unknown bone "${bone}"`);
    if (bone.startsWith("eye_")) throw new Error("Eyes translate inside the visor: use setEyeDirection({yaw,pitch}) instead of moveJoint");
    this.overrides.set(bone, angles, o);
  }
  releaseJoint(bone?: string, fade = 0.35) {
    if (bone) this.overrides.release(bone, fade);
    else this.overrides.releaseAll(fade);
  }
  /** Current joint-space angles (after animation + overrides) with limits, for UIs. */
  getJointAngles(bone: string) {
    const e = this.joints.currentEuler(bone);
    return { bone, angles: e, limits: rawLimits(bone), overridden: this.overrides.has(bone) };
  }
  listJoints() {
    const out: { bone: string; label: string; side: Side | null }[] = [];
    for (const d of JOINT_DEFS) {
      const sided = d.mirror;
      for (const s of sided ? (["L", "R"] as const) : [null]) {
        const bone = s ? `${d.id}_${s}` : d.id;
        if (this.joints.has(bone)) out.push({ bone, label: s ? `${d.label} ${s}` : d.label, side: s });
      }
    }
    return out;
  }
  /** Set finger curl (0..1 per finger) or a named preset: open, relaxed, fist, point, thumbsUp, pinch. */
  setHand(side: "left" | "right" | Side, pose: keyof typeof HAND_PRESETS | FingerCurl, o: { fade?: number; hold?: number } = {}) {
    const s: Side = side === "left" || side === "L" ? "L" : "R";
    const curl = typeof pose === "string" ? HAND_PRESETS[pose] : pose;
    if (!curl) throw new Error(`Unknown hand pose "${String(pose)}"`);
    for (const [bone, e] of Object.entries(fingerPose(s, curl))) this.overrides.set(bone, { x: e[0], y: e[1], z: e[2] }, { fade: 0.2, ...o });
  }
  releaseHand(side: "left" | "right" | Side) {
    const s: Side = side === "left" || side === "L" ? "L" : "R";
    for (const bone of this.joints.names) if (bone.startsWith("finger_") && bone.endsWith(`_${s}`)) this.overrides.release(bone, 0.3);
  }

  // ================================================================ IK reach / point
  /** Point (or reach) the hand at a world-space target using arm IK. */
  pointAt(target: Vec3, o: { hand?: "left" | "right" | "auto"; hold?: number; fingers?: boolean; look?: boolean; handLength?: number } = {}) {
    const t = new THREE.Vector3(target.x, target.y, target.z);
    let side: Side;
    if (o.hand === "left") side = "L";
    else if (o.hand === "right") side = "R";
    else side = this.root.worldToLocal(t.clone()).x >= 0 ? "L" : "R";
    const r = this.reach[side];
    r.target = t;
    r.goal = 1;
    r.hold = o.hold ?? 2.5;
    r.handLength = o.handLength ?? 0.13;
    for (const k of ["L", "R"] as Side[]) if (k !== side && this.reach[k].goal === 1 && this.reach[k].target) this.reach[k].goal = 0;
    if (o.fingers !== false) this.setHand(side, "point", { hold: r.hold + 0.2 });
    if (o.look !== false) this.lookAt(target);
    this.emit("animation:start", { name: "pointAt", channels: [`arm${side}` as Channel] });
  }
  stopPointing() {
    for (const s of ["L", "R"] as Side[]) {
      this.reach[s].goal = 0;
      this.reach[s].hold = null;
      this.releaseHand(s);
    }
  }
  /** 0..1 how strongly IK currently controls an arm (tests/UI) */
  reachWeight(side: Side) {
    return this.reach[side].weight;
  }

  // ================================================================ locomotion
  walkTo(target: { x: number; z: number }, o: WalkOptions = {}): Promise<boolean> {
    this.emit("walk:start", { x: target.x, z: target.z });
    const p = this.locomotion.walkTo(target.x, target.z, o);
    return p.then((ok) => {
      return ok;
    });
  }
  turnTo(yawDegrees: number): Promise<boolean> {
    return this.locomotion.turnTo(yawDegrees);
  }
  turnBy(degrees: number): Promise<boolean> {
    return this.locomotion.turnBy(degrees);
  }

  // ================================================================ speech
  speak(o: SpeakOptions): SpeechHandle {
    this.stopSpeech(true);
    const token = ++this.speechToken;
    const lipSync = o.lipSync !== false;
    const prevEmotion = this.face.emotion;
    if (o.emotion) this.setEmotion(o.emotion);
    const gestures = o.gestures !== false;
    if (gestures) {
      this.animation.play("talkR");
      this.animation.play("talkL");
    }
    if (this.stateMachine.state !== "speaking") this.stateMachine.set("speaking", { fromSpeech: true });

    let resolveFinished!: () => void;
    const finished = new Promise<void>((r) => (resolveFinished = r));
    let mode: SpeechHandle["mode"] = "silent";
    let audioHandle: PlayingAudio | null = null;
    let ttsStop: (() => void) | null = null;
    let interrupted = false;

    let ended = false;
    const done = () => {
      if (token !== this.speechToken || ended) return;
      ended = true;
      this.speech = null;
      this.lipsync.stop();
      if (gestures) {
        this.animation.stop("talkR");
        this.animation.stop("talkL");
      }
      if (!o.keepEmotion && o.emotion) this.setEmotion(prevEmotion.name, prevEmotion.intensity);
      this.stateMachine.speechEnded();
      this.emit("speech:end", { interrupted });
      resolveFinished();
    };
    const stop = () => {
      interrupted = true;
      audioHandle?.stop();
      ttsStop?.();
      done();
    };
    this.speech = { token, stop };

    const start = async () => {
      try {
        let loaded: LoadedAudio | undefined = o.audio;
        if (!loaded && o.audioUrl) {
          this.audio ??= new AudioController();
          await this.audio.resume();
          loaded = await this.audio.load(o.audioUrl);
        }
        if (token !== this.speechToken) return;
        if (loaded) {
          mode = "audio";
          this.audio ??= new AudioController();
          await this.audio.resume();
          let events: VisemeEvent[];
          if (o.visemes) events = o.visemes;
          else if (o.text) {
            // hybrid: place the text's visemes inside the audio's real speech segments
            events = alignTextToActivity(o.text, activeIntervals(loaded.envelope.data, loaded.envelope.hop));
            if (!events.length) events = textToVisemeEvents(o.text, { totalDuration: loaded.buffer.duration * 0.98 });
          }
          else events = loaded.analysis.events;
          audioHandle = this.audio.play(loaded.buffer);
          this.emit("speech:start", { text: o.text, mode, duration: loaded.buffer.duration });
          if (lipSync) this.lipsync.playTimeline(events, { clock: audioHandle.time, envelope: loaded.envelope, onEnd: () => undefined });
          void audioHandle.ended.then(() => token === this.speechToken && (this.lipsync.stop(), done()));
          return;
        }
        if (!o.text && !o.visemes) {
          done();
          return;
        }
        const rate = o.rate ?? 1;
        const est = o.text ? estimateSpeechDuration(o.text, rate) : 1;
        const useTTS = o.tts !== false && !!o.text && speechSynthesisAvailable() && window.speechSynthesis.getVoices().length > 0;
        if (useTTS) {
          mode = "tts";
          const h = speakWithBrowserTTS(o.text!, { lang: o.lang, rate });
          ttsStop = h.stop;
          let virtual = 0;
          let last = performance.now();
          let skew = 0;
          const events = o.visemes ?? textToVisemeEvents(o.text!, { rate });
          h.onBoundary = (charIndex) => {
            // re-sync the virtual clock to the spoken position (word boundary)
            skew = (charIndex / Math.max(1, o.text!.length)) * est - virtual;
          };
          this.emit("speech:start", { text: o.text, mode, duration: est });
          if (lipSync) {
            this.lipsync.playTimeline(events, {
              clock: () => {
                const n = performance.now();
                virtual += (n - last) / 1000;
                last = n;
                if (skew) {
                  virtual += skew * 0.5;
                  skew *= 0.5;
                  if (Math.abs(skew) < 1e-3) skew = 0;
                }
                return virtual;
              },
              streaming: true,
            });
          }
          void h.ended.then(() => token === this.speechToken && done());
          return;
        }
        // silent preview: run the viseme timeline against an internal clock
        mode = "silent";
        const events = o.visemes ?? textToVisemeEvents(o.text!, { rate });
        this.emit("speech:start", { text: o.text, mode, duration: est });
        if (lipSync) this.lipsync.playTimeline(events, { onEnd: () => token === this.speechToken && done() });
        else this.after(est, () => token === this.speechToken && done());
      } catch (err) {
        this.emit("error", { message: (err as Error).message });
        done();
      }
    };
    void start();
    return { finished, stop, get mode() { return mode; } };
  }

  /** Stream PCM16 audio from a TTS service; the mouth follows the audio (or pushed visemes). */
  speakStream(o: StreamSpeechOptions = {}): StreamSpeechHandle {
    this.stopSpeech(true);
    const token = ++this.speechToken;
    this.audio ??= new AudioController();
    const stream: PcmStream = this.audio.createPcmStream(o.sampleRate ?? 24000);
    const prev = this.face.emotion;
    if (o.emotion) this.setEmotion(o.emotion);
    const gestures = o.gestures !== false;
    if (gestures) {
      this.animation.play("talkR");
      this.animation.play("talkL");
    }
    this.stateMachine.set("speaking", { fromSpeech: true });
    this.lipsync.startLive(this.audio.liveSource());
    let usingVisemes = false;
    let finishedOnce = false;
    const finish = () => {
      if (token !== this.speechToken || finishedOnce) return;
      finishedOnce = true;
      this.speech = null;
      this.lipsync.stop();
      if (gestures) {
        this.animation.stop("talkR");
        this.animation.stop("talkL");
      }
      if (o.emotion) this.setEmotion(prev.name, prev.intensity);
      this.stateMachine.speechEnded();
      this.emit("speech:end", { interrupted: false });
    };
    this.speech = { token, stop: () => { stream.stop(); finish(); } };
    this.emit("speech:start", { mode: "audio" });
    const finished = stream.ended.then(finish);
    return {
      pushPCM16: (c) => stream.pushPCM16(c),
      pushVisemes: (ev) => {
        if (!usingVisemes) {
          usingVisemes = true;
          this.lipsync.playTimeline([], { clock: stream.time, streaming: true });
        }
        this.lipsync.pushEvents(ev);
      },
      end: () => {
        this.lipsync.endStream();
        stream.end();
      },
      stop: () => this.speech?.stop(),
      finished,
    };
  }

  stopSpeech(silent = false) {
    if (this.speech) {
      const s = this.speech;
      s.stop();
      this.speech = null;
    }
    void silent;
  }
  get speaking() {
    return this.speech !== null;
  }

  // ================================================================ state machine / reset
  setState(s: AssistantState) {
    this.stateMachine.set(s);
  }

  stop() {
    this.stopSpeech();
    this.animation.stop();
    this.locomotion.stop();
    this.stopPointing();
  }

  /** Back to the default standing pose: clears animations, joint overrides, IK, expression and speech. */
  resetPose(o: { position?: boolean } = {}) {
    this.stopSpeech();
    this.animation.clear();
    this.overrides.clear();
    this.locomotion.halt();
    for (const s of ["L", "R"] as Side[]) {
      this.reach[s].goal = 0;
      this.reach[s].weight = 0;
      this.reach[s].target = null;
    }
    this.face.reset();
    this.gaze.setTarget(null);
    this.gaze.manualEyes = null;
    this.stateMachine.reset();
    this.setGlow();
    if (o.position) {
      this.root.position.set(0, 0, 0);
      this.root.rotation.y = 0;
    }
    this.locomotion.plantFeetNeutral();
    this.animation.play("idle", { fadeIn: 0.2 });
  }

  // ================================================================ introspection
  getStatus() {
    const p = this.root.position;
    return {
      state: this.stateMachine.state,
      emotion: this.face.emotion,
      eyeExpression: this.face.eyeExpression,
      mouthOpen: +this.face.mouthOpenValue.toFixed(3),
      animations: this.animation.active(),
      speaking: this.speaking,
      lipsync: { active: this.lipsync.active, energy: +this.lipsync.energy.toFixed(3), weights: this.lipsync.currentWeights },
      gaze: this.gaze.angles,
      locomotion: { state: this.locomotion.state, x: +p.x.toFixed(3), z: +p.z.toFixed(3), yawDeg: +(this.root.rotation.y / DEG).toFixed(1), speed: +this.locomotion.speed.toFixed(2) },
      overrides: this.overrides.active(),
      reach: { L: +this.reach.L.weight.toFixed(2), R: +this.reach.R.weight.toFixed(2) },
    };
  }

  dispose() {
    this.stopSpeech();
    this.animation.dispose();
    this.audio?.dispose();
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach((x) => x.dispose());
        (m as THREE.SkinnedMesh).skeleton?.dispose();
      }
    });
    this.root.removeFromParent();
  }
}

export { parseBone, clampEuler };
