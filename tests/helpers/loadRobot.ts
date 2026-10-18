import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));
import * as THREE from "three";
import { parseRobotGLTF, inspectRobotModel } from "../../src/engine/loader";

export type RobotStyle = "friendly" | "futuristic" | "premium" | "concierge" | "mascot";

export async function loadModelNode(style: RobotStyle = "premium") {
  const file = path.resolve(__dir, `../../public/models/robot_${style}.glb`);
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const gltf = await parseRobotGLTF(ab);
  return { gltf, parts: inspectRobotModel(gltf) };
}

export function worldPos(o: THREE.Object3D, root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  return o.getWorldPosition(new THREE.Vector3());
}
