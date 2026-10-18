import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { loadModelNode, type RobotStyle } from "./helpers/loadRobot";
import { REQUIRED_BONES, REQUIRED_MORPHS, JointSpace } from "../src/engine/rig";

const styles: RobotStyle[] = ["friendly", "futuristic", "premium", "concierge", "mascot"];

describe.each(styles)("robot model (%s)", (style) => {
  it("is a skinned, rigged model with the documented bones and morph targets", async () => {
    const { parts } = await loadModelNode(style);
    expect(parts.skinned.length).toBe(parts.meshes.size); // every mesh is skinned (no rigid cheating)
    const bones = new Set<string>();
    parts.scene.traverse((o) => (o as THREE.Bone).isBone && bones.add(o.name));
    for (const b of REQUIRED_BONES) expect(bones.has(b), `bone ${b}`).toBe(true);
    for (const [mesh, names] of Object.entries(REQUIRED_MORPHS)) {
      const m = parts.meshes.get(mesh)!;
      for (const n of names) expect(m.morphTargetDictionary![n], `${mesh}.${n}`).toBeTypeOf("number");
    }
    expect(bones.size).toBe(40);
  });

  it("is lean enough for 60 FPS: few draw calls, bounded triangles, PBR materials", async () => {
    const { parts } = await loadModelNode(style);
    let tris = 0;
    for (const m of parts.meshes.values()) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    expect(parts.meshes.size).toBeLessThanOrEqual(12); // draw calls per pass
    expect(tris).toBeLessThan(style === "concierge" ? 130000 : 70000);
    for (const mat of parts.materials.values()) expect((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial).toBe(true);
    expect(parts.materials.has("Mat_Glow")).toBe(true);
  });

  it("has a sane rest pose (head above the pelvis, ankles on the ground, arms beside the torso, left = +X, straight legs)", async () => {
    const { parts } = await loadModelNode(style);
    const c = new THREE.Group();
    c.add(parts.scene);
    const js = new JointSpace(c);
    expect(js.restWorldPos("head").y).toBeGreaterThan(js.restWorldPos("pelvis").y + 0.15);
    expect(js.restWorldPos("head").y).toBeGreaterThan(0.4);
    expect(js.restWorldPos("foot_L").y).toBeGreaterThan(0.03);
    expect(js.restWorldPos("foot_L").y).toBeLessThan(0.1);
    expect(js.restWorldPos("hand_L").x).toBeGreaterThan(js.restWorldPos("pelvis").x + 0.15);
    // left is +X on both sides
    expect(js.restWorldPos("thigh_L").x).toBeGreaterThan(0);
    expect(js.restWorldPos("thigh_R").x).toBeLessThan(0);
    // legs start perfectly straight: the IK solver relies on it
    const l = js.restWorldPos("thigh_L");
    expect(Math.abs(js.restWorldPos("shin_L").x - l.x)).toBeLessThan(1e-4);
    expect(Math.abs(js.restWorldPos("foot_L").z - l.z)).toBeLessThan(1e-4);
  });
});
