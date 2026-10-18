import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makeRobot, lp } from "./helpers/robot";
import { JOINT_DEFS, clampEuler, eulerToQuat, quatToEuler, rawLimits, armPose, headPose, type EulerOrder } from "../src/engine/rig";

describe("joint space", () => {
  it("round-trips Euler <-> quaternion for every joint order within limits", () => {
    for (const order of ["YXZ", "XZY", "ZXY"] as EulerOrder[]) {
      for (const e of [{ x: 30, y: -40, z: 20 }, { x: -120, y: 35, z: 45 }, { x: 10, y: 80, z: -30 }]) {
        const back = quatToEuler(eulerToQuat(e, order), order);
        const q2 = eulerToQuat(back, order);
        expect(q2.angleTo(eulerToQuat(e, order))).toBeLessThan(1e-6);
      }
    }
  });

  it("clamps to natural limits and mirrors them for the right side", () => {
    expect(clampEuler("forearm_L", { x: -200, y: 0, z: 0 }).x).toBe(-150);
    expect(clampEuler("shin_L", { x: -20, y: 0, z: 0 }).x).toBe(0); // knees do not bend backwards
    const l = rawLimits("upperarm_L");
    const r = rawLimits("upperarm_R");
    expect(r.z).toEqual([-l.z[1], -l.z[0]]);
    expect(r.x).toEqual(l.x);
    expect(JOINT_DEFS.length).toBeGreaterThan(20);
  });

  it("a joint-space delta is applied identically regardless of the Blender bone frame", async () => {
    const r = await makeRobot();
    // the same semantic command on mirrored arms must give mirrored hand positions
    r.joints.resetAll();
    for (const [b, e] of Object.entries(armPose("L", { shoulder: 50, abduction: 30, elbow: 70 }))) r.joints.setEuler(b, { x: e[0], y: e[1], z: e[2] });
    const hl = lp(r, "hand_L");
    r.joints.resetAll();
    for (const [b, e] of Object.entries(armPose("R", { shoulder: 50, abduction: 30, elbow: 70 }))) r.joints.setEuler(b, { x: e[0], y: e[1], z: e[2] });
    const hr = lp(r, "hand_R");
    expect(hl.x).toBeCloseTo(-hr.x, 3);
    expect(hl.y).toBeCloseTo(hr.y, 3);
    expect(hl.z).toBeCloseTo(hr.z, 3);
  });

  it("semantic angle signs: shoulder raises the arm forward, abduction outward, elbow folds the forearm forward, head yaw/pitch", async () => {
    const r = await makeRobot();
    r.joints.resetAll();
    const rest = { handL: lp(r, "hand_L"), handR: lp(r, "hand_R"), eye: lp(r, "eye_L") };
    const apply = (pose: Record<string, [number, number, number]>) => {
      r.joints.resetAll();
      for (const [b, e] of Object.entries(pose)) r.joints.setEuler(b, { x: e[0], y: e[1], z: e[2] });
    };
    apply(armPose("L", { shoulder: 80 }));
    expect(lp(r, "hand_L").z).toBeGreaterThan(rest.handL.z + 0.25);
    apply(armPose("L", { abduction: 60 }));
    expect(lp(r, "hand_L").x).toBeGreaterThan(rest.handL.x + 0.2); // left hand moves toward +X (away from body)
    apply(armPose("R", { abduction: 60 }));
    expect(lp(r, "hand_R").x).toBeLessThan(rest.handR.x - 0.2);
    apply(armPose("L", { elbow: 90 }));
    expect(lp(r, "hand_L").z).toBeGreaterThan(rest.handL.z + 0.15);
    apply({ head: headPose({ pitch: 30 }) });
    expect(lp(r, "eye_L").y).toBeGreaterThan(rest.eye.y + 0.03); // look up: face rises
    expect(lp(r, "eye_L").z).toBeLessThan(rest.eye.z - 0.03);
    apply({ head: headPose({ yaw: 30 }) });
    expect(lp(r, "eye_L").x).toBeGreaterThan(rest.eye.x + 0.03); // yaw+ = toward the character's left (+X)
  });

  it("legs stay straight and symmetrical at rest (IK precondition)", async () => {
    const r = await makeRobot();
    const a = lp(r, "foot_L");
    const b = lp(r, "foot_R");
    expect(a.x).toBeCloseTo(-b.x, 4);
    expect(a.y).toBeCloseTo(r.joints.restWorldPos("foot_L").y, 2);
    expect(Math.abs(a.z)).toBeLessThan(0.01);
    const q = new THREE.Quaternion();
    r.joints.currentDelta("pelvis", q);
    expect(q.angleTo(new THREE.Quaternion())).toBeLessThan(0.05);
  });
});
