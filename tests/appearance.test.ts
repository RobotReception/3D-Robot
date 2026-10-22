import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { loadModelNode, type RobotStyle } from "./helpers/loadRobot";
import { RobotAvatar } from "../src/engine/RobotAvatar";

const tex = () => {
  const t = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
  t.needsUpdate = true;
  return t;
};

describe("appearance", () => {
  it("recolours parts and resets to the authored colours", async () => {
    const robot = new RobotAvatar((await loadModelNode("concierge")).parts);
    const before = robot.getColors();
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["body", "joints", "uniform", "eyes", "light"]));
    robot.setColors({ uniform: "#0080c6", accent: "#f78a2c", eyes: "#acd9e7" });
    expect(robot.getColors()).toMatchObject({ uniform: "#0080c6", accent: "#f78a2c", eyes: "#acd9e7" });
    robot.resetColors();
    expect(robot.getColors()).toEqual(before);
  });

  it("ignores parts a model does not have", async () => {
    const robot = new RobotAvatar((await loadModelNode("friendly")).parts);
    robot.setColors({ uniform: "#ff0000" });
    expect(robot.getColors().uniform).toBeUndefined();
  });

  it.each<RobotStyle>(["friendly", "premium", "concierge", "mascot", "futuristic"])("puts a logo on the chest surface that follows the chest (%s)", async (style) => {
    const robot = new RobotAvatar((await loadModelNode(style)).parts);
    await robot.setLogo(tex());
    expect(robot.hasLogo).toBe(true);
    const logo = robot.root.getObjectByName("Logo")!;
    expect(logo.parent?.name).toBe("chest");
    robot.root.updateMatrixWorld(true);
    const p = logo.getWorldPosition(new THREE.Vector3());
    const chest = robot.joints.restWorldPos("chest");
    expect(p.z).toBeGreaterThan(chest.z + 0.04); // on the front of the torso, not inside it
    expect(p.y).toBeGreaterThan(chest.y);
    robot.playAnimation("bow");
    for (let i = 0; i < 60; i++) robot.update(1 / 60);
    robot.root.updateMatrixWorld(true);
    expect(logo.getWorldPosition(new THREE.Vector3()).distanceTo(p)).toBeGreaterThan(0.02); // moves with the body
    await robot.setLogo(null);
    expect(robot.root.getObjectByName("Logo")).toBeUndefined();
  });
});
