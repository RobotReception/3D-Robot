import * as THREE from "three";
import { FINGERS, SIDES, eulerOrderFor, eulerToQuat, type JointSpace, type RawPose } from "./rig";

/**
 * Animation channels partition the skeleton so independent motions can run in
 * parallel (speak + point + look) without fighting over the same bones.
 * Legs are not a clip channel: they are driven by the locomotion/IK controller.
 */
export type Channel = "head" | "torso" | "armL" | "armR" | "fingersL" | "fingersR";
export const CHANNELS: Channel[] = ["head", "torso", "armL", "armR", "fingersL", "fingersR"];

export function channelBones(): Record<Channel, string[]> {
  const out: Record<Channel, string[]> = {
    head: ["neck", "head"],
    torso: ["pelvis", "spine", "chest"],
    armL: [], armR: [], fingersL: [], fingersR: [],
  };
  for (const s of SIDES) {
    out[`arm${s}` as Channel].push(`clavicle_${s}`, `upperarm_${s}`, `forearm_${s}`, `hand_${s}`);
    for (const f of FINGERS) out[`fingers${s}` as Channel].push(`finger_${f}_1_${s}`, `finger_${f}_2_${s}`);
  }
  return out;
}
const BONE_CHANNEL = (() => {
  const m = new Map<string, Channel>();
  for (const [c, bs] of Object.entries(channelBones())) for (const b of bs) m.set(b, c as Channel);
  return m;
})();
export const channelOf = (bone: string) => BONE_CHANNEL.get(bone) ?? null;

/** One sampled frame of a clip: joint-space Euler degrees + optional pelvis offset (meters). */
export interface PoseFrame {
  joints?: RawPose;
  /** pelvis translation in model axes (x left, y up, z forward) */
  pelvis?: [number, number, number];
}

export interface ClipDef {
  name: string;
  duration: number;
  loop: boolean;
  /** higher wins a channel. 0 base idle · 1 state poses · 3 speech gestures · 6 emotive one-shots · 8 commanded gestures */
  priority: number;
  fadeIn?: number;
  fadeOut?: number;
  /** evaluated at sampling time; t in seconds (0..duration), loops must be periodic */
  pose: (t: number, u: number) => PoseFrame;
  /** restrict which channels the clip claims (default: those containing bones it poses) */
  channels?: Channel[];
  description?: string;
}

export const merge = (...ps: (RawPose | undefined)[]): RawPose => Object.assign({}, ...ps.filter(Boolean));
export const smooth = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/** Interpolate between keyed frames with smoothstep easing. keys: [time, frame] ascending. */
export function keyed(keys: [number, PoseFrame][]): (t: number) => PoseFrame {
  return (t: number) => {
    if (t <= keys[0][0]) return keys[0][1];
    const last = keys[keys.length - 1];
    if (t >= last[0]) return last[1];
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
    const [t0, a] = keys[i];
    const [t1, b] = keys[i + 1];
    return lerpFrame(a, b, smooth((t - t0) / (t1 - t0)));
  };
}

export function lerpFrame(a: PoseFrame, b: PoseFrame, k: number): PoseFrame {
  const joints: RawPose = {};
  const names = new Set([...Object.keys(a.joints ?? {}), ...Object.keys(b.joints ?? {})]);
  for (const n of names) {
    const x = a.joints?.[n] ?? [0, 0, 0];
    const y = b.joints?.[n] ?? [0, 0, 0];
    joints[n] = [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
  }
  const pa = a.pelvis ?? [0, 0, 0];
  const pb = b.pelvis ?? [0, 0, 0];
  return { joints, pelvis: [pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k] };
}

export const SAMPLE_RATE = 30;

/** Bake a ClipDef into one THREE.AnimationClip per claimed channel. */
export function bakeClip(def: ClipDef, joints: JointSpace): Map<Channel, THREE.AnimationClip> {
  const n = Math.max(2, Math.round(def.duration * SAMPLE_RATE) + 1);
  const times: number[] = [];
  const frames: PoseFrame[] = [];
  const touched = new Set<Channel>(def.channels ?? []);
  for (let i = 0; i < n; i++) {
    const t = Math.min(def.duration, (i / (n - 1)) * def.duration);
    const f = def.pose(t, t / def.duration);
    times.push(t);
    frames.push(f);
    if (!def.channels) {
      for (const b of Object.keys(f.joints ?? {})) {
        const c = channelOf(b);
        if (c) touched.add(c);
      }
      if (f.pelvis) touched.add("torso");
    }
  }
  const bonesByChannel = channelBones();
  const out = new Map<Channel, THREE.AnimationClip>();
  const q = new THREE.Quaternion();
  const loc = new THREE.Quaternion();
  const off = new THREE.Vector3();
  const pos = new THREE.Vector3();
  for (const ch of touched) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const bone of bonesByChannel[ch]) {
      if (!joints.has(bone)) continue;
      const order = eulerOrderFor(bone);
      const qv: number[] = [];
      for (const f of frames) {
        const e = f.joints?.[bone] ?? [0, 0, 0];
        eulerToQuat({ x: e[0], y: e[1], z: e[2] }, order, q);
        joints.localFromDelta(bone, q, loc);
        qv.push(loc.x, loc.y, loc.z, loc.w);
      }
      // keep quaternion hemisphere continuous so slerp takes the short arc
      for (let i = 1; i < times.length; i++) {
        const d = qv[i * 4] * qv[i * 4 - 4] + qv[i * 4 + 1] * qv[i * 4 - 3] + qv[i * 4 + 2] * qv[i * 4 - 2] + qv[i * 4 + 3] * qv[i * 4 - 1];
        if (d < 0) for (let k = 0; k < 4; k++) qv[i * 4 + k] *= -1;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, qv));
      if (bone === "pelvis") {
        const pv: number[] = [];
        for (const f of frames) {
          off.set(...(f.pelvis ?? [0, 0, 0]));
          joints.localPosFromOffset("pelvis", off, pos);
          pv.push(pos.x, pos.y, pos.z);
        }
        tracks.push(new THREE.VectorKeyframeTrack("pelvis.position", times, pv));
      }
    }
    out.set(ch, new THREE.AnimationClip(`${def.name}:${ch}`, def.duration, tracks));
  }
  return out;
}
