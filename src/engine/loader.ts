import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { REQUIRED_BONES, REQUIRED_MORPHS } from "./rig";

export interface LoadOptions {
  /** URL of the Draco decoder folder (only needed if the GLB is Draco-compressed). */
  dracoPath?: string;
}

export interface RobotModelParts {
  scene: THREE.Group;
  skinned: THREE.SkinnedMesh[];
  /** meshes by name: Eye_L, Eye_R, Mouth, Brow_L, Brow_R, Body_*, Visor, Glow */
  meshes: Map<string, THREE.Mesh>;
  materials: Map<string, THREE.Material>;
}

function configure(loader: GLTFLoader, opts: LoadOptions) {
  // Meshopt keeps morph targets/skins intact and decodes fast (preferred for characters).
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (opts.dracoPath) {
    const d = new DRACOLoader();
    d.setDecoderPath(opts.dracoPath);
    loader.setDRACOLoader(d);
  }
  return loader;
}

export async function loadRobotGLTF(url: string, opts: LoadOptions = {}): Promise<GLTF> {
  return configure(new GLTFLoader(), opts).loadAsync(url);
}

export function parseRobotGLTF(data: ArrayBuffer, opts: LoadOptions = {}): Promise<GLTF> {
  return new Promise((res, rej) => configure(new GLTFLoader(), opts).parse(data, "", res, rej));
}

/** Validates the rig contract and indexes the parts. Throws with a precise message. */
export function inspectRobotModel(gltf: GLTF): RobotModelParts {
  const bones = new Set<string>();
  const meshes = new Map<string, THREE.Mesh>();
  const skinned: THREE.SkinnedMesh[] = [];
  const materials = new Map<string, THREE.Material>();
  gltf.scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.add(o.name);
    if ((o as THREE.Mesh).isMesh) {
      const m = o as THREE.Mesh;
      meshes.set(m.name, m);
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(m as THREE.SkinnedMesh);
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) materials.set(mat.name, mat);
    }
  });
  const missingBones = REQUIRED_BONES.filter((b) => !bones.has(b));
  const missingMorphs: string[] = [];
  for (const [mesh, names] of Object.entries(REQUIRED_MORPHS)) {
    const m = meshes.get(mesh);
    if (!m) {
      missingMorphs.push(`${mesh} (mesh missing)`);
      continue;
    }
    for (const n of names) if (!m.morphTargetDictionary || !(n in m.morphTargetDictionary)) missingMorphs.push(`${mesh}.${n}`);
  }
  if (missingBones.length || missingMorphs.length) {
    throw new Error(
      `Not a valid robot rig. Missing bones: [${missingBones.join(", ")}] Missing morph targets: [${missingMorphs.join(", ")}]`,
    );
  }
  for (const s of skinned) {
    s.frustumCulled = false; // bounds of bind pose are not valid for animated limbs
    s.castShadow = true;
    s.receiveShadow = true;
  }
  return { scene: gltf.scene, skinned, meshes, materials };
}
