import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makeRobot } from "./helpers/robot";

const DT = 1 / 60;
const deg = (a: THREE.Quaternion, b: THREE.Quaternion) => (a.angleTo(b) * 180) / Math.PI;

/** largest per-frame rotation (degrees) of a bone while stepping `seconds` */
function maxStep(r: Awaited<ReturnType<typeof makeRobot>>, bone: string, seconds: number, each?: (i: number) => void) {
  let prev = r.joints.bone(bone).quaternion.clone(), m = 0;
  for (let i = 0; i < seconds / DT; i++) {
    each?.(i);
    r.update(DT);
    const q = r.joints.bone(bone).quaternion;
    m = Math.max(m, deg(q, prev));
    prev = q.clone();
  }
  return m;
}

describe("motion smoothness (regressions)", () => {
  it("walking: arms swing continuously and opposite to the legs (no 40° flip every step)", async () => {
    const r = await makeRobot("concierge");
    r.update(0.5);
    void r.walkTo({ x: 0, z: 4 });
    expect(maxStep(r, "upperarm_R", 5)).toBeLessThan(5);
    // contralateral swing: right hand forward when the left foot is forward
    const z = (b: string) => { r.root.updateMatrixWorld(true); return r.root.worldToLocal(r.joints.bone(b).getWorldPosition(new THREE.Vector3())).z; };
    const hR: number[] = [], fL: number[] = [];
    for (let i = 0; i < 150; i++) { r.update(DT); hR.push(z("hand_R")); fL.push(z("foot_L")); }
    const n = hR.length, mean = (a: number[]) => a.reduce((s, x) => s + x) / n, mh = mean(hR), mf = mean(fL);
    let sab = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sab += (hR[i] - mh) * (fL[i] - mf); sa += (hR[i] - mh) ** 2; sb += (fL[i] - mf) ** 2; }
    expect(sab / Math.sqrt(sa * sb)).toBeGreaterThan(0.5);
  });

  it("starting to walk does not make the robot sag: the pelvis stays within 6 cm of its standing height", async () => {
    const r = await makeRobot("concierge");
    r.update(0.5);
    r.root.updateMatrixWorld(true);
    const y0 = r.joints.bone("pelvis").getWorldPosition(new THREE.Vector3()).y;
    void r.walkTo({ x: 2, z: 2.5 });
    let lowest = y0;
    for (let i = 0; i < 60 * 6; i++) {
      r.update(DT);
      r.root.updateMatrixWorld(true);
      lowest = Math.min(lowest, r.joints.bone("pelvis").getWorldPosition(new THREE.Vector3()).y);
    }
    expect(y0 - lowest).toBeLessThan(0.06);
  });

  it("the idle base comes back with a fade after a gesture or speech (no one-frame snap)", async () => {
    const r = await makeRobot("concierge");
    r.update(0.5);
    r.speak({ text: "Hello, welcome. How can I help you today?", tts: false } as never);
    let m = 0;
    for (let i = 0; i < 60 * 7; i++) {
      const prev = r.joints.bone("forearm_R").quaternion.clone();
      r.update(DT);
      m = Math.max(m, deg(r.joints.bone("forearm_R").quaternion, prev));
    }
    expect(m).toBeLessThan(3.2); // was a 21° jump when the speech gesture ended (and 4°+/frame at the start)
  });

  it("gesture fades ease in: the first frames move far less than the middle of the fade (a linear ramp starts at full speed)", async () => {
    const r = await makeRobot("concierge");
    r.update(0.5);
    r.playAnimation("thinking");
    const steps: number[] = [];
    let prev = r.joints.bone("forearm_R").quaternion.clone();
    for (let i = 0; i < 20; i++) { r.update(DT); const q = r.joints.bone("forearm_R").quaternion; steps.push(deg(q, prev)); prev = q.clone(); }
    expect(steps[0]).toBeLessThan(0.1);
    expect(steps[0]).toBeLessThan(steps[15] * 0.15);
  });
});
