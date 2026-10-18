import * as THREE from "three";

/**
 * Rig layer: bone names, joint limits and the "joint space" abstraction.
 *
 * JOINT SPACE
 * -----------
 * Blender bones have arbitrary local axes (Y along the bone, roll...). To make
 * every joint controllable with predictable angles, rotations are expressed as a
 * *model-axis delta relative to the rest pose*:
 *
 *   X = pitch about the model's left axis   (+X rotates "up" toward forward => nod down)
 *   Y = yaw   about the model's up axis      (+Y turns toward the character's LEFT, +X side)
 *   Z = roll  about the model's forward axis (+Z tilts the top toward the character's RIGHT)
 *
 * with the character facing +Z and its left side at +X. The delta is applied in the
 * parent's (rest-aligned) frame, so it composes hierarchically like any FK chain:
 *   local = P⁻¹ · d · P · restLocal      (P = parent rest world rotation)
 * Euler order is chosen per joint so the axis with the largest range is never the
 * "middle" one (whose decomposition is limited to +-90 deg):
 *   axial joints (spine/neck/head/eyes)  "YXZ"  yaw outermost
 *   limb hinges/swings (arm, leg, hand)  "XZY"  flexion outermost, abduction, twist innermost
 *   fingers                              "ZXY"  curl (z) outermost
 * Angles are degrees.
 */

export type Side = "L" | "R";
export const SIDES: Side[] = ["L", "R"];
export const FINGERS = ["thumb", "index", "middle", "ring"] as const;
export type FingerName = (typeof FINGERS)[number];

/** Axial joints (spine, neck, head, eyes) use yaw-pitch-roll; limb joints apply the twist about the bone axis first. */
export type EulerOrder = "YXZ" | "ZXY" | "XZY";
const DEG = Math.PI / 180;

/** Every bone the engine requires in a robot GLB (see docs/RIG.md). */
export const REQUIRED_BONES: string[] = (() => {
  const b = ["root", "pelvis", "spine", "chest", "neck", "head"];
  for (const s of SIDES) {
    b.push(`eye_${s}`, `clavicle_${s}`, `upperarm_${s}`, `forearm_${s}`, `hand_${s}`);
    b.push(`thigh_${s}`, `shin_${s}`, `foot_${s}`, `toe_${s}`);
    for (const f of FINGERS) b.push(`finger_${f}_1_${s}`, `finger_${f}_2_${s}`);
  }
  return b;
})();

export const REQUIRED_MORPHS: Record<string, string[]> = {
  Eye_L: ["eyeBlink", "eyeSquint", "eyeWide", "eyeHappy", "eyeSad", "eyeAngry", "eyeSurprised", "eyeCurious"],
  Eye_R: ["eyeBlink", "eyeSquint", "eyeWide", "eyeHappy", "eyeSad", "eyeAngry", "eyeSurprised", "eyeCurious"],
  Mouth: [
    "mouthOpen", "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD", "viseme_kk", "viseme_CH",
    "viseme_SS", "viseme_nn", "viseme_RR", "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
    "mouthSmile", "mouthFrown", "mouthSurprise",
  ],
  Brow_L: ["browUp", "browDown", "browInnerUp", "browInnerDown"],
  Brow_R: ["browUp", "browDown", "browInnerUp", "browInnerDown"],
};

/** Eye gaze is a translation of the eye bones inside the visor plane (meters at full deflection). */
export const EYE_TRAVEL = { x: 0.034, y: 0.022, maxYaw: 26, maxPitch: 19 };

export type Axis = "x" | "y" | "z";
export interface JointLimits {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}
export interface JointDef {
  /** bone name without side suffix for sided joints, e.g. "upperarm" */
  id: string;
  label: string;
  /** y/z are negated for the right side so a pose authored for the left mirrors correctly. */
  mirror: boolean;
  order: EulerOrder;
  limits: JointLimits;
}

const Z0: [number, number] = [0, 0];
export const JOINT_DEFS: JointDef[] = [
  { id: "pelvis", label: "Pelvis", mirror: false, order: "YXZ", limits: { x: [-15, 15], y: [-30, 30], z: [-12, 12] } },
  { id: "spine", label: "Spine", mirror: false, order: "YXZ", limits: { x: [-20, 30], y: [-35, 35], z: [-15, 15] } },
  { id: "chest", label: "Chest", mirror: false, order: "YXZ", limits: { x: [-15, 25], y: [-35, 35], z: [-12, 12] } },
  { id: "neck", label: "Neck", mirror: false, order: "YXZ", limits: { x: [-30, 35], y: [-60, 60], z: [-30, 30] } },
  { id: "head", label: "Head", mirror: false, order: "YXZ", limits: { x: [-35, 40], y: [-75, 75], z: [-35, 35] } },
  { id: "clavicle", label: "Clavicle", mirror: true, order: "XZY", limits: { x: [-20, 20], y: [-12, 12], z: [-15, 25] } },
  { id: "upperarm", label: "Shoulder", mirror: true, order: "XZY", limits: { x: [-190, 60], y: [-95, 95], z: [-30, 88] } },
  { id: "forearm", label: "Elbow", mirror: true, order: "XZY", limits: { x: [-150, 5], y: [-90, 90], z: Z0 } },
  { id: "hand", label: "Wrist", mirror: true, order: "XZY", limits: { x: [-70, 70], y: [-85, 85], z: [-30, 30] } },
  { id: "thigh", label: "Hip", mirror: true, order: "XZY", limits: { x: [-120, 35], y: [-35, 35], z: [-30, 30] } },
  { id: "shin", label: "Knee", mirror: true, order: "XZY", limits: { x: [0, 140], y: Z0, z: Z0 } },
  { id: "foot", label: "Ankle", mirror: true, order: "XZY", limits: { x: [-40, 40], y: [-20, 20], z: [-20, 20] } },
  { id: "toe", label: "Toe", mirror: true, order: "XZY", limits: { x: [-50, 15], y: Z0, z: Z0 } },
];
for (const f of FINGERS) {
  for (const seg of [1, 2]) {
    JOINT_DEFS.push({
      id: `finger_${f}_${seg}`,
      label: `${f} ${seg}`,
      mirror: true,
      order: "ZXY",
      limits: { x: [-20, 20], y: Z0, z: seg === 1 ? [-100, 20] : [-110, 10] },
    });
  }
}

const defByBase = new Map(JOINT_DEFS.map((d) => [d.id, d] as const));

export function parseBone(name: string): { base: string; side: Side | null } {
  const m = /^(.*)_(L|R)$/.exec(name);
  return m ? { base: m[1], side: m[2] as Side } : { base: name, side: null };
}
export function jointDef(bone: string): JointDef | undefined {
  return defByBase.get(parseBone(bone).base);
}
export function mirrorSign(bone: string): 1 | -1 {
  const { base, side } = parseBone(bone);
  return side === "R" && defByBase.get(base)?.mirror ? -1 : 1;
}

/** Limits in the bone's own raw joint-space axes (already mirrored for the right side). */
export function rawLimits(bone: string): JointLimits {
  const def = jointDef(bone);
  if (!def) return { x: [-180, 180], y: [-180, 180], z: [-180, 180] };
  const s = mirrorSign(bone);
  const flip = (r: [number, number]): [number, number] => (s < 0 ? [-r[1], -r[0]] : r);
  return { x: def.limits.x, y: flip(def.limits.y), z: flip(def.limits.z) };
}

export type EulerDeg = { x: number; y: number; z: number };
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampEuler(bone: string, e: EulerDeg): EulerDeg {
  const l = rawLimits(bone);
  return { x: clamp(e.x, ...l.x), y: clamp(e.y, ...l.y), z: clamp(e.z, ...l.z) };
}

export function eulerOrderFor(bone: string): EulerOrder {
  return jointDef(bone)?.order ?? "YXZ";
}

const _e = new THREE.Euler();
export function eulerToQuat(e: EulerDeg, order: EulerOrder, out = new THREE.Quaternion()): THREE.Quaternion {
  _e.set(e.x * DEG, e.y * DEG, e.z * DEG, order);
  return out.setFromEuler(_e);
}
export function quatToEuler(q: THREE.Quaternion, order: EulerOrder): EulerDeg {
  _e.setFromQuaternion(q, order);
  return { x: _e.x / DEG, y: _e.y / DEG, z: _e.z / DEG };
}

// --------------------------------------------------------------------------- JointSpace
interface BoneRest {
  bone: THREE.Bone;
  parentWorldQ: THREE.Quaternion; // P
  parentWorldQInv: THREE.Quaternion;
  restLocalQ: THREE.Quaternion;
  restLocalQInv: THREE.Quaternion;
  restLocalPos: THREE.Vector3;
  restWorldQ: THREE.Quaternion; // model-space
  restWorldPos: THREE.Vector3; // model-space
  parent: string | null;
}

/**
 * Caches the rest pose of the skeleton and converts between joint-space deltas and
 * the bones' local transforms. Must be created while the container is at identity.
 */
export class JointSpace {
  private rest = new Map<string, BoneRest>();
  readonly names: string[] = [];

  constructor(public readonly container: THREE.Object3D) {
    container.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(container.matrixWorld).invert();
    const bones: THREE.Bone[] = [];
    container.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });
    const m = new THREE.Matrix4();
    const pw = new THREE.Quaternion();
    for (const bone of bones) {
      m.multiplyMatrices(inv, bone.matrixWorld);
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      m.decompose(wp, wq, new THREE.Vector3());
      const parentBone = (bone.parent as THREE.Bone)?.isBone ? (bone.parent as THREE.Bone) : null;
      if (parentBone) {
        m.multiplyMatrices(inv, parentBone.matrixWorld);
        m.decompose(new THREE.Vector3(), pw, new THREE.Vector3());
      } else {
        // parent is the armature node: its orientation relative to the container
        m.multiplyMatrices(inv, bone.parent!.matrixWorld);
        m.decompose(new THREE.Vector3(), pw, new THREE.Vector3());
      }
      this.rest.set(bone.name, {
        bone,
        parentWorldQ: pw.clone(),
        parentWorldQInv: pw.clone().invert(),
        restLocalQ: bone.quaternion.clone(),
        restLocalQInv: bone.quaternion.clone().invert(),
        restLocalPos: bone.position.clone(),
        restWorldQ: wq,
        restWorldPos: wp,
        parent: parentBone ? parentBone.name : null,
      });
      this.names.push(bone.name);
    }
  }

  has(name: string) {
    return this.rest.has(name);
  }
  bone(name: string): THREE.Bone {
    const r = this.rest.get(name);
    if (!r) throw new Error(`Unknown bone "${name}"`);
    return r.bone;
  }
  parentOf(name: string) {
    return this.rest.get(name)?.parent ?? null;
  }
  restWorldPos(name: string) {
    return this.rest.get(name)!.restWorldPos;
  }
  restWorldQuat(name: string) {
    return this.rest.get(name)!.restWorldQ;
  }
  restLocalPos(name: string) {
    return this.rest.get(name)!.restLocalPos;
  }

  /** local quaternion for joint-space delta `d` */
  localFromDelta(name: string, d: THREE.Quaternion, out = new THREE.Quaternion()) {
    const r = this.rest.get(name)!;
    return out.copy(r.parentWorldQInv).multiply(d).multiply(r.parentWorldQ).multiply(r.restLocalQ);
  }
  /** joint-space delta of a local quaternion */
  deltaFromLocal(name: string, local: THREE.Quaternion, out = new THREE.Quaternion()) {
    const r = this.rest.get(name)!;
    return out.copy(r.parentWorldQ).multiply(local).multiply(r.restLocalQInv).multiply(r.parentWorldQInv);
  }
  /** current joint-space delta of the bone (as posed right now) */
  currentDelta(name: string, out = new THREE.Quaternion()) {
    return this.deltaFromLocal(name, this.bone(name).quaternion, out);
  }
  currentEuler(name: string): EulerDeg {
    return quatToEuler(this.currentDelta(name), eulerOrderFor(name));
  }
  /** accumulated model-space rotation of the bone relative to its rest orientation (product of joint deltas up the chain) */
  worldDelta(name: string, out = new THREE.Quaternion()): THREE.Quaternion {
    const chain: string[] = [];
    for (let n: string | null = name; n; n = this.rest.get(n)!.parent) chain.push(n);
    out.identity();
    for (let i = chain.length - 1; i >= 0; i--) out.multiply(this.currentDelta(chain[i], _q3));
    return out;
  }
  /** pre-multiply an additive joint-space delta onto the bone's current pose */
  applyDelta(name: string, d: THREE.Quaternion) {
    const r = this.rest.get(name)!;
    const b = r.bone;
    const cur = _q1.copy(b.quaternion);
    b.quaternion.copy(r.parentWorldQInv).multiply(d).multiply(r.parentWorldQ).multiply(cur);
  }
  setEuler(name: string, e: EulerDeg) {
    this.localFromDelta(name, eulerToQuat(e, eulerOrderFor(name), _q2), this.bone(name).quaternion);
  }
  /** joint-space position offset (meters, model axes) -> local position */
  setPositionOffset(name: string, off: THREE.Vector3) {
    const r = this.rest.get(name)!;
    r.bone.position.copy(off).applyQuaternion(r.parentWorldQInv).add(r.restLocalPos);
  }
  localPosFromOffset(name: string, off: THREE.Vector3, out = new THREE.Vector3()) {
    const r = this.rest.get(name)!;
    return out.copy(off).applyQuaternion(r.parentWorldQInv).add(r.restLocalPos);
  }
  positionOffset(name: string, out = new THREE.Vector3()) {
    const r = this.rest.get(name)!;
    return out.copy(r.bone.position).sub(r.restLocalPos).applyQuaternion(r.parentWorldQ);
  }
  resetBone(name: string) {
    const r = this.rest.get(name)!;
    r.bone.quaternion.copy(r.restLocalQ);
    r.bone.position.copy(r.restLocalPos);
  }
  resetAll() {
    for (const r of this.rest.values()) {
      r.bone.quaternion.copy(r.restLocalQ);
      r.bone.position.copy(r.restLocalPos);
    }
  }
}
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

// --------------------------------------------------------------------------- semantic arm / head mapping
/** Public, human-readable arm angles (degrees). Mirrored automatically for the right arm. */
export interface ArmAngles {
  /** forward raise (+) / backward (-) */
  shoulder?: number;
  /** sideways raise (+) away from the body */
  abduction?: number;
  /** upper-arm twist about its own axis */
  twist?: number;
  /** elbow flexion 0..150 */
  elbow?: number;
  /** forearm twist (pronation/supination) */
  wrist?: number;
  /** wrist flexion (+ = hand forward/up) */
  wristFlex?: number;
}
export interface HeadAngles {
  /** + = turn toward the character's left */
  yaw?: number;
  /** + = look up */
  pitch?: number;
  /** + = tilt toward the character's left shoulder */
  roll?: number;
}

export type RawPose = Record<string, [number, number, number]>;

export function armPose(side: Side, a: ArmAngles): RawPose {
  const m = side === "R" ? -1 : 1;
  const p: RawPose = {};
  const up: [number, number, number] = [0, 0, 0];
  if (a.shoulder !== undefined) up[0] = -a.shoulder;
  if (a.abduction !== undefined) up[2] = m * a.abduction;
  if (a.twist !== undefined) up[1] = m * a.twist;
  p[`upperarm_${side}`] = up;
  if (a.elbow !== undefined || a.wrist !== undefined) {
    p[`forearm_${side}`] = [-(a.elbow ?? 0), m * (a.wrist ?? 0), 0];
  }
  if (a.wristFlex !== undefined) p[`hand_${side}`] = [-a.wristFlex, 0, 0];
  return p;
}
export function headPose(a: HeadAngles): [number, number, number] {
  return [-(a.pitch ?? 0), a.yaw ?? 0, -(a.roll ?? 0)];
}

/** Finger curl presets: 0 = straight, 1 = fully curled. */
export type FingerCurl = Partial<Record<FingerName, number>>;
export function fingerPose(side: Side, curl: FingerCurl, spread = 0): RawPose {
  const m = side === "R" ? -1 : 1;
  const p: RawPose = {};
  for (const f of FINGERS) {
    const c = curl[f];
    if (c === undefined) continue;
    const k1 = f === "thumb" ? -65 : -85;
    const k2 = f === "thumb" ? -70 : -95;
    const sp = f === "thumb" ? 0 : f === "index" ? -spread : f === "ring" ? spread : 0;
    p[`finger_${f}_1_${side}`] = [sp, 0, m * k1 * c];
    p[`finger_${f}_2_${side}`] = [0, 0, m * k2 * c];
  }
  return p;
}
export const HAND_PRESETS: Record<string, FingerCurl> = {
  open: { thumb: 0, index: 0, middle: 0, ring: 0 },
  relaxed: { thumb: 0.15, index: 0.2, middle: 0.25, ring: 0.3 },
  fist: { thumb: 0.8, index: 1, middle: 1, ring: 1 },
  point: { thumb: 0.7, index: 0, middle: 1, ring: 1 },
  thumbsUp: { thumb: 0, index: 1, middle: 1, ring: 1 },
  pinch: { thumb: 0.55, index: 0.55, middle: 0.1, ring: 0.1 },
};
