import * as THREE from "three";

/**
 * Version 2 models ship a baked texture atlas (baseColor+AO, normal,
 * metallicRoughness, emissive) authored by blender/build_robot.py — their look
 * is final, so we only keep the glass visor reflective. Version 1 models are
 * flat-coloured and get the original hand-tuned finish pass.
 */
export function applyNaturalAppearance(materials: Iterable<THREE.Material>) {
  for (const material of materials) {
    if (!(material instanceof THREE.MeshStandardMaterial)) continue;
    const textured = material.map !== null || material.normalMap !== null;
    if (textured) {
      if (material.name === "Mat_Visor") material.envMapIntensity = Math.max(material.envMapIntensity, 0.8);
      continue;
    }
    switch (material.name) {
      case "Mat_Shell":
      case "Mat_Shell2":
        material.roughness = Math.max(material.roughness, 0.48);
        material.metalness = Math.min(material.metalness, 0.18);
        break;
      case "Mat_Visor":
        material.color.set("#161e27");
        material.roughness = 0.42;
        material.metalness = 0;
        material.envMapIntensity = 0.12;
        break;
      case "Mat_Face":
        material.color.set("#b7cbd0");
        material.roughness = 0.72;
        material.metalness = 0;
        break;
      case "Mat_Glow":
        material.color.set("#647d86");
        material.roughness = 0.65;
        material.metalness = 0.08;
        break;
      case "Mat_Accent":
      case "Mat_Dark":
      case "Mat_Uniform":
        material.roughness = Math.max(material.roughness, 0.52);
        material.metalness = Math.min(material.metalness, 0.3);
        break;
    }
    if (material instanceof THREE.MeshPhysicalMaterial) {
      material.clearcoat = Math.min(material.clearcoat, 0.15);
      material.clearcoatRoughness = Math.max(material.clearcoatRoughness, 0.5);
    }
  }
}
