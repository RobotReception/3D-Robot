import * as THREE from "three";
import { RobotAvatar } from "../../src/engine/RobotAvatar";
import { loadModelNode, type RobotStyle } from "./loadRobot";

export async function makeRobot(style: RobotStyle = "premium", opts: ConstructorParameters<typeof RobotAvatar>[1] = {}) {
  const { gltf } = await loadModelNode(style);
  // deterministic randomness: no random blinks / glances unless a test wants them
  return RobotAvatar.fromGLTF(gltf, { rng: () => 0.5, autoBlink: false, idleGaze: false, ...opts });
}

export function run(r: RobotAvatar, seconds: number, fps = 60) {
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) r.update(1 / fps);
}

export const wp = (r: RobotAvatar, bone: string) => {
  r.root.updateMatrixWorld(true);
  return r.joints.bone(bone).getWorldPosition(new THREE.Vector3());
};
/** position in the robot's own frame (x left, y up, z forward) */
export const lp = (r: RobotAvatar, bone: string) => r.root.worldToLocal(wp(r, bone));
export const morph = (r: RobotAvatar, mesh: string, name: string) => {
  const m = r.parts.meshes.get(mesh)!;
  return m.morphTargetInfluences![m.morphTargetDictionary![name]];
};
