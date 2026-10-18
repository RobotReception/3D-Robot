import * as THREE from "three";
import { clampEuler, eulerOrderFor, eulerToQuat, quatToEuler, type EulerDeg, type JointSpace } from "./rig";

interface Axes {
  x?: number;
  y?: number;
  z?: number;
}
interface Entry {
  target: Axes; // raw joint-space degrees
  cur: Required<Axes> | null;
  weight: number;
  weightTarget: number;
  fade: number; // seconds
  hold: number | null; // auto-release timer
  smooth: number; // tau seconds for value changes
}

/**
 * Direct, absolute joint control layered on top of animation. A joint with an
 * override ignores the animated value on the overridden axes; releasing blends back.
 * Values are clamped to the joint limits ("natural range of motion").
 */
export class JointOverrides {
  private map = new Map<string, Entry>();
  constructor(private joints: JointSpace) {}

  /** @param angles raw joint-space degrees for this bone (use rig.armPose/headPose for semantic angles) */
  set(bone: string, angles: Axes, o: { fade?: number; hold?: number; smooth?: number } = {}) {
    const lim = clampEuler(bone, { x: angles.x ?? 0, y: angles.y ?? 0, z: angles.z ?? 0 });
    const clamped: Axes = {};
    for (const k of ["x", "y", "z"] as const) if (angles[k] !== undefined) clamped[k] = lim[k];
    let e = this.map.get(bone);
    if (!e) {
      e = { target: {}, cur: null, weight: 0, weightTarget: 1, fade: 0.25, hold: null, smooth: 0.07 };
      this.map.set(bone, e);
    }
    Object.assign(e.target, clamped);
    e.weightTarget = 1;
    e.fade = Math.max(0.01, o.fade ?? 0.25);
    e.smooth = Math.max(0.005, o.smooth ?? 0.07);
    e.hold = o.hold ?? null;
  }
  release(bone: string, fade = 0.35) {
    const e = this.map.get(bone);
    if (e) {
      e.weightTarget = 0;
      e.fade = Math.max(0.01, fade);
      e.hold = null;
    }
  }
  releaseAll(fade = 0.35) {
    for (const b of this.map.keys()) this.release(b, fade);
  }
  clear() {
    this.map.clear();
  }
  has(bone: string) {
    const e = this.map.get(bone);
    return !!e && e.weightTarget > 0;
  }
  active(): string[] {
    return [...this.map.entries()].filter(([, e]) => e.weightTarget > 0).map(([b]) => b);
  }
  getTarget(bone: string): Axes | null {
    return this.map.get(bone)?.target ?? null;
  }

  apply(dt: number) {
    const q = new THREE.Quaternion();
    for (const [bone, e] of this.map) {
      if (e.hold !== null) {
        e.hold -= dt;
        if (e.hold <= 0) {
          e.weightTarget = 0;
          e.hold = null;
        }
      }
      const step = dt / e.fade;
      e.weight += Math.sign(e.weightTarget - e.weight) * Math.min(Math.abs(e.weightTarget - e.weight), step);
      if (e.weight <= 0 && e.weightTarget === 0) {
        this.map.delete(bone);
        continue;
      }
      const order = eulerOrderFor(bone);
      const anim = quatToEuler(this.joints.currentDelta(bone), order);
      if (!e.cur) e.cur = { x: e.target.x ?? anim.x, y: e.target.y ?? anim.y, z: e.target.z ?? anim.z };
      const k = 1 - Math.exp(-dt / e.smooth);
      const w = e.weight * e.weight * (3 - 2 * e.weight);
      const out: EulerDeg = { ...anim };
      for (const ax of ["x", "y", "z"] as const) {
        if (e.target[ax] === undefined) continue;
        e.cur[ax] += (e.target[ax]! - e.cur[ax]) * k;
        out[ax] = anim[ax] + (e.cur[ax] - anim[ax]) * w;
      }
      this.joints.localFromDelta(bone, eulerToQuat(out, order, q), this.joints.bone(bone).quaternion);
    }
  }
}
