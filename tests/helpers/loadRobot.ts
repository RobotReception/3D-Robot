import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dir = path.dirname(fileURLToPath(import.meta.url));
import * as THREE from "three";
import { parseRobotGLTF, inspectRobotModel } from "../../src/engine/loader";

export type RobotStyle = "friendly" | "futuristic" | "premium" | "concierge" | "mascot";

function withoutTextures(glb: ArrayBuffer): ArrayBuffer {
  const source = new Uint8Array(glb);
  const input = new DataView(glb);
  const jsonLength = input.getUint32(12, true);
  const jsonEnd = 20 + jsonLength;
  const json = JSON.parse(new TextDecoder().decode(source.subarray(20, jsonEnd))) as Record<string, unknown>;
  delete json.images;
  delete json.textures;
  delete json.samplers;
  const strip = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) strip(item);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (key.endsWith("Texture") || key === "textures") delete record[key];
      else strip(child);
    }
  };
  strip(json.materials);
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const padding = (4 - (encoded.length % 4)) % 4;
  const tail = source.subarray(jsonEnd);
  const output = new Uint8Array(20 + encoded.length + padding + tail.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.length, true);
  view.setUint32(12, encoded.length + padding, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(encoded, 20);
  output.fill(0x20, 20 + encoded.length, 20 + encoded.length + padding);
  output.set(tail, 20 + encoded.length + padding);
  return output.buffer;
}

export async function loadModelNode(style: RobotStyle = "premium") {
  const file = path.resolve(__dir, `../../public/models/robot_${style}.glb`);
  const buf = fs.readFileSync(file);
  // copy into the active JS realm; GLTFLoader's `data instanceof ArrayBuffer`
  // check fails for ArrayBuffers created inside other realms (e.g. fs buffers
  // under vitest's jsdom environment).
  const ab = new Uint8Array(buf.byteLength);
  ab.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const gltf = await parseRobotGLTF(withoutTextures(ab.buffer as ArrayBuffer));
  return { gltf, parts: inspectRobotModel(gltf) };
}

export function worldPos(o: THREE.Object3D, root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  return o.getWorldPosition(new THREE.Vector3());
}
