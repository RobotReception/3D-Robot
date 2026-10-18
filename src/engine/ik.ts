import * as THREE from "three";
import { clampEuler, eulerOrderFor, quatToEuler, eulerToQuat, type JointSpace } from "./rig";

/** Shortest-arc rotation taking unit vector `a` to unit vector `b`. */
export function arc(a: THREE.Vector3, b: THREE.Vector3, out = new THREE.Quaternion()) {
  return out.setFromUnitVectors(a, b);
}

export interface TwoBoneSolution {
  /** unit direction root->mid */
  upper: THREE.Vector3;
  /** unit direction mid->end */
  lower: THREE.Vector3;
  mid: THREE.Vector3;
  end: THREE.Vector3;
  /** true when the target was out of reach and clamped */
  clamped: boolean;
}

/**
 * Analytic two-bone IK (law of cosines). `pole` selects the bend side
 * (knee/elbow points toward it).
 */
export function solveTwoBone(
  root: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3,
): TwoBoneSolution {
  const toT = new THREE.Vector3().subVectors(target, root);
  const dist = toT.length();
  const maxReach = (l1 + l2) * 0.999;
  const minReach = Math.abs(l1 - l2) + 1e-3;
  const d = Math.min(maxReach, Math.max(minReach, dist));
  const clamped = d !== dist;
  const dir = dist > 1e-6 ? toT.clone().divideScalar(dist) : new THREE.Vector3(0, -1, 0);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const pp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir)));
  if (pp.lengthSq() < 1e-8) pp.set(0, 0, 1).sub(dir.clone().multiplyScalar(dir.z));
  pp.normalize();
  const mid = root.clone().addScaledVector(dir, x).addScaledVector(pp, h);
  const end = root.clone().addScaledVector(dir, d);
  return {
    upper: mid.clone().sub(root).normalize(),
    lower: end.clone().sub(mid).normalize(),
    mid, end, clamped,
  };
}

export interface LimbDef {
  upper: string;
  lower: string;
  end: string; // the bone whose position is the IK end effector (hand / foot)
}

export interface LimbRest {
  l1: number;
  l2: number;
  dirUpper: THREE.Vector3; // rest direction upper->lower (model space)
  dirLower: THREE.Vector3; // rest direction lower->end
}

export function limbRest(joints: JointSpace, d: LimbDef): LimbRest {
  const a = joints.restWorldPos(d.upper);
  const b = joints.restWorldPos(d.lower);
  const c = joints.restWorldPos(d.end);
  return {
    l1: a.distanceTo(b), l2: b.distanceTo(c),
    dirUpper: b.clone().sub(a).normalize(), dirLower: c.clone().sub(b).normalize(),
  };
}

export interface LimbPose {
  /** model-space rotation of the upper bone relative to rest */
  worldUpper: THREE.Quaternion;
  /** model-space rotation of the lower bone relative to rest */
  worldLower: THREE.Quaternion;
  clamped: boolean;
}

/**
 * Solve a limb toward `target` (model space) and write the upper/lower bone rotations.
 * @param parentDelta model-space rotation (vs rest) of the upper bone's parent
 * @param blend 0..1 how much of the IK result replaces the current pose
 */
export function applyLimbIK(
  joints: JointSpace, def: LimbDef, rest: LimbRest, rootPos: THREE.Vector3, target: THREE.Vector3,
  pole: THREE.Vector3, parentDelta: THREE.Quaternion, blend = 1,
): LimbPose {
  const sol = solveTwoBone(rootPos, target, rest.l1, rest.l2, pole);
  const wU = arc(rest.dirUpper, sol.upper);
  const wL = arc(rest.dirLower, sol.lower);
  const dU = parentDelta.clone().invert().multiply(wU);
  const dL = wU.clone().invert().multiply(wL);
  setClampedDelta(joints, def.upper, dU, blend);
  setClampedDelta(joints, def.lower, dL, blend);
  return { worldUpper: wU, worldLower: wL, clamped: sol.clamped };
}

const _tmp = new THREE.Quaternion();
/** Write a joint-space delta to the bone, clamped to the joint limits and blended with the current pose. */
export function setClampedDelta(joints: JointSpace, bone: string, delta: THREE.Quaternion, blend = 1) {
  const order = eulerOrderFor(bone);
  const e = clampEuler(bone, quatToEuler(delta, order));
  eulerToQuat(e, order, _tmp);
  const b = joints.bone(bone);
  const target = joints.localFromDelta(bone, _tmp, new THREE.Quaternion());
  if (blend >= 1) b.quaternion.copy(target);
  else b.quaternion.slerp(target, blend);
}
