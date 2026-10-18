import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makeRobot, run, lp, wp, morph } from "./helpers/robot";
import { executeCommand, executeMessage } from "../src/engine/commands";
import { attachBridge, type BridgeTransport } from "../src/engine/bridge";
import { ASSISTANT_STATES } from "../src/engine/stateMachine";

const flush = () => new Promise((r) => setTimeout(r, 0));
const deg = (r: ReturnType<typeof lp>) => r;
void deg;

describe("Robot API is wired to real bones and morphs", () => {
  it("moveHead drives the head+neck bones to the requested angles (within limits)", async () => {
    const r = await makeRobot();
    r.moveHead({ yaw: 20, pitch: 10, roll: 0 });
    run(r, 1.2);
    const head = r.joints.currentEuler("head");
    const neck = r.joints.currentEuler("neck");
    expect(head.y + neck.y).toBeCloseTo(20, 0); // yaw split head 65% / neck 35%
    expect(-(head.x + neck.x)).toBeCloseTo(10, 0); // pitch up = negative X
    // limits are enforced
    r.moveHead({ yaw: 500 });
    run(r, 1);
    expect(r.joints.currentEuler("head").y + r.joints.currentEuler("neck").y).toBeLessThanOrEqual(85.5); // combined natural range
    // release returns control to the animation
    r.releaseJoint();
    run(r, 1.5);
    expect(Math.abs(r.joints.currentEuler("head").y)).toBeLessThan(6);
  });

  it("moveArm sets shoulder/elbow/wrist and mirrors for the right arm", async () => {
    const r = await makeRobot();
    r.moveArm("right", { shoulder: 30, elbow: 45, wrist: 10 });
    r.moveArm("left", { shoulder: 30, elbow: 45, wrist: 10 });
    run(r, 1.2);
    const R = r.joints.currentEuler("upperarm_R");
    const L = r.joints.currentEuler("upperarm_L");
    expect(R.x).toBeCloseTo(-30, 0);
    expect(L.x).toBeCloseTo(-30, 0);
    expect(r.joints.currentEuler("forearm_R").x).toBeCloseTo(-45, 0);
    const hr = lp(r, "hand_R");
    const hl = lp(r, "hand_L");
    expect(hr.x).toBeCloseTo(-hl.x, 1); // mirrored (abduction still follows the idle animation, which differs slightly per side)
    expect(hr.z).toBeCloseTo(hl.z, 1);
    expect(hr.z).toBeGreaterThan(0.1);
    // unspecified axes keep following the animation (abduction was not overridden)
    expect(r.overrides.getTarget("upperarm_R")).toEqual({ x: -30 });
  });

  it("elbow hyper-extension and shoulder range are clamped", async () => {
    const r = await makeRobot();
    r.moveArm("left", { elbow: 400 });
    run(r, 1);
    expect(r.joints.currentEuler("forearm_L").x).toBeGreaterThanOrEqual(-150.5);
    r.moveJoint("shin_L", { x: -50 });
    run(r, 1);
    expect(r.joints.currentEuler("shin_L").x).toBeGreaterThanOrEqual(-0.5);
  });

  it("moveJoint accepts any bone, rejects unknown bones and eyes (which translate)", async () => {
    const r = await makeRobot();
    r.moveJoint("spine", { y: 20 }, { smooth: 0.02 });
    run(r, 0.8);
    expect(r.joints.currentEuler("spine").y).toBeCloseTo(20, 0);
    expect(() => r.moveJoint("tail", { x: 1 })).toThrow(/Unknown bone/);
    expect(() => r.moveJoint("eye_L", { x: 1 })).toThrow(/setEyeDirection/);
  });

  it("fingers: presets curl joints; releasing restores them", async () => {
    const r = await makeRobot();
    r.setHand("right", "fist");
    run(r, 1);
    expect(Math.abs(r.joints.currentEuler("finger_index_1_R").z)).toBeGreaterThan(60);
    const open = lp(r, "finger_index_2_R").y;
    r.releaseHand("right");
    run(r, 1.2);
    expect(Math.abs(r.joints.currentEuler("finger_index_1_R").z)).toBeLessThan(40);
    expect(lp(r, "finger_index_2_R").y).toBeLessThan(open + 1); // sanity: finite
    r.setHand("left", { index: 1, middle: 0 });
    run(r, 1);
    expect(Math.abs(r.joints.currentEuler("finger_index_1_L").z)).toBeGreaterThan(60);
    expect(Math.abs(r.joints.currentEuler("finger_middle_1_L").z)).toBeLessThan(5);
  });

  it("lookAt turns head and eyes toward a world point; null releases", async () => {
    const r = await makeRobot();
    r.lookAt({ x: 2, y: 1.3, z: 2 }); // 45 deg to the left (+X)
    run(r, 2);
    const g = r.gaze.angles;
    expect(g.headYaw + g.eyeYaw).toBeGreaterThan(40);
    expect(g.headYaw).toBeGreaterThan(20);
    const eyeL = lp(r, "eye_L");
    r.root.updateMatrixWorld(true);
    r.lookAt({ x: -2, y: 1.3, z: 2 });
    run(r, 2);
    expect(r.gaze.angles.headYaw).toBeLessThan(-20);
    expect(lp(r, "eye_L").x).toBeLessThan(eyeL.x);
    r.lookAt(null);
    run(r, 2);
    expect(Math.abs(r.gaze.angles.headYaw)).toBeLessThan(2);
  });

  it("lookAt(Object3D) tracks a moving object, and keeps working after the robot turns", async () => {
    const r = await makeRobot();
    const o = new THREE.Object3D();
    o.position.set(0, 1.4, 3);
    r.lookAt(o);
    run(r, 1.5);
    o.position.set(-3, 1.4, 3);
    run(r, 2);
    expect(r.gaze.angles.headYaw).toBeLessThan(-20);
    void r.turnTo(-60);
    run(r, 3);
    // target is at bearing -45deg in world; robot faces -60 -> target is ~+15deg to its left: gaze must have followed
    expect(r.gaze.angles.headYaw + r.gaze.angles.eyeYaw).toBeGreaterThan(5);
  });

  it("setEyeDirection moves the eye bones independently", async () => {
    const r = await makeRobot();
    run(r, 0.5);
    const c = lp(r, "eye_L");
    r.setEyeDirection({ yaw: 26, pitch: 0 });
    run(r, 1);
    const moved = lp(r, "eye_L");
    expect(moved.x - c.x).toBeGreaterThan(0.025);
    expect(Math.abs(moved.z - c.z)).toBeLessThan(0.015); // translation inside the visor plane
    r.setEyeDirection(null);
  });

  it("each eye can be steered independently, and one eye can wink", async () => {
    const r = await makeRobot();
    run(r, 0.5);
    const l0 = lp(r, "eye_L");
    const r0 = lp(r, "eye_R");
    r.setEyeDirection({ yaw: 26, pitch: 0 }, "left");
    r.setEyeDirection({ yaw: -26, pitch: 0 }, "right");
    run(r, 1);
    expect(lp(r, "eye_L").x - l0.x).toBeGreaterThan(0.025);
    expect(lp(r, "eye_R").x - r0.x).toBeLessThan(-0.025); // cross-eyed: right eye moved the other way
    r.setEyeDirection(null);
    r.blink("left");
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < 40; i++) {
      r.update(1 / 60);
      peakL = Math.max(peakL, morph(r, "Eye_L", "eyeBlink"));
      peakR = Math.max(peakR, morph(r, "Eye_R", "eyeBlink"));
    }
    expect(peakL).toBeGreaterThan(0.95);
    expect(peakR).toBeLessThan(0.02); // wink: the other eye stays open
  });

  it("moveTorso turns/leans the upper body (spine+chest) and moveArm shrug lifts a shoulder", async () => {
    const r = await makeRobot();
    run(r, 0.3);
    const shrugOnly = await makeRobot();
    run(shrugOnly, 0.3);
    const sh0 = lp(shrugOnly, "upperarm_L").y;
    shrugOnly.moveArm("left", { shrug: 20 });
    run(shrugOnly, 1);
    expect(lp(shrugOnly, "upperarm_L").y).toBeGreaterThan(sh0 + 0.02); // shoulder rose
    r.moveTorso({ yaw: 40, pitch: 20, roll: 10 });
    run(r, 1.2);
    const e = (b: string) => r.joints.currentEuler(b);
    expect(e("spine").y + e("chest").y).toBeCloseTo(40, 0);
    expect(e("spine").x + e("chest").x).toBeCloseTo(20, 0);
    expect(r.root.worldToLocal(wp(r, "head")).x).toBeGreaterThan(0.01); // leaning to the left (+X)
    r.moveTorso({ yaw: 500, pitch: 500 }); // clamped
    run(r, 1);
    expect(e("spine").y + e("chest").y).toBeLessThanOrEqual(60.5);
  });

  it("pointAt solves arm IK: the fingertip reaches a reachable target and the arm is unclamped", async () => {
    const r = await makeRobot();
    const target = { x: 0.5, y: 1.2, z: 0.35 }; // within arm reach
    r.pointAt(target, { hand: "left", hold: 10 });
    run(r, 2);
    expect(r.reachWeight("L")).toBeCloseTo(1, 1);
    const wrist = lp(r, "hand_L");
    const toT = new THREE.Vector3(target.x, target.y, target.z).sub(wrist);
    expect(toT.length()).toBeLessThan(0.2); // wrist is one hand-length from the target
    const fingertip = lp(r, "finger_index_2_L");
    expect(fingertip.distanceTo(new THREE.Vector3(target.x, target.y, target.z))).toBeLessThan(0.12);
    // auto hand picks the side of the target
    const r2 = await makeRobot();
    r2.pointAt({ x: -1, y: 1.2, z: 1 });
    run(r2, 1.5);
    expect(r2.reachWeight("R")).toBeGreaterThan(0.9);
    expect(r2.reachWeight("L")).toBeLessThan(0.05);
    // releases after the hold time
    run(r2, 5);
    expect(r2.reachWeight("R")).toBeLessThan(0.05);
  });

  it("pointAt out of reach clamps to a straight arm pointing toward the target", async () => {
    const r = await makeRobot();
    r.pointAt({ x: 6, y: 1.2, z: 0 }, { hand: "left", hold: 10 });
    run(r, 2);
    const sh = lp(r, "upperarm_L");
    const hand = lp(r, "hand_L");
    const dir = hand.clone().sub(sh).normalize();
    expect(dir.x).toBeGreaterThan(0.9);
    expect(hand.clone().sub(sh).length()).toBeLessThan(0.45);
  });

  it("resetPose returns every driven bone to the rest pose and clears all layers", async () => {
    const r = await makeRobot();
    r.moveHead({ yaw: 40 });
    r.moveArm("left", { shoulder: 70 });
    r.playAnimation("happy");
    r.pointAt({ x: 1, y: 1.3, z: 1 });
    r.setEmotion("angry");
    r.setMouthOpen(0.8);
    r.speak({ text: "this is a long sentence that should be interrupted", tts: false });
    void r.walkTo({ x: 1, z: 1 });
    run(r, 0.7);
    r.resetPose({ position: true });
    run(r, 3);
    expect(r.root.position.length()).toBeLessThan(1e-6);
    expect(r.speaking).toBe(false);
    expect(r.overrides.active()).toEqual([]);
    expect(r.animation.active().armL).toEqual(["idle"]);
    for (const [b, tol] of [["head", 6], ["upperarm_L", 12], ["forearm_R", 14], ["spine", 4], ["thigh_L", 12]] as const) {
      const q = r.joints.currentDelta(b);
      expect(q.angleTo(new THREE.Quaternion()) * 57.3, b).toBeLessThan(tol);
    }
    expect(morph(r, "Eye_L", "eyeAngry")).toBeLessThan(0.02);
    expect(morph(r, "Mouth", "mouthOpen")).toBeLessThan(0.02);
    expect(r.stateMachine.state).toBe("idle");
  });
});

describe("state machine", () => {
  it("each assistant state applies its coordinated bundle (pose clip, emotion, glow)", async () => {
    const r = await makeRobot();
    const seen: string[] = [];
    r.on("state", (e) => seen.push(`${e.from}>${e.to}`));
    r.setState("listening");
    run(r, 0.8);
    expect(r.animation.ownerOf("head")!.name).toBe("listening");
    expect(r.face.emotion.name).toBe("friendly");
    r.setState("thinking");
    run(r, 0.8);
    expect(r.animation.ownerOf("armR")!.name).toBe("thinking");
    expect(r.animation.isPlaying("listening")).toBe(false);
    expect(r.face.emotion.name).toBe("thinking");
    r.setState("idle");
    run(r, 1.2);
    expect(r.animation.ownerOf("armR")!.name).toBe("idle");
    expect(seen).toEqual(["idle>listening", "listening>thinking", "thinking>idle"]);
    expect(ASSISTANT_STATES).toEqual(["idle", "listening", "thinking", "speaking", "error"]);
  });

  it("error state is locked briefly, can be forced, and returns to idle on its own", async () => {
    const r = await makeRobot();
    r.setState("error");
    run(r, 0.3);
    expect(r.stateMachine.set("listening")).toBe(false);
    expect(r.stateMachine.state).toBe("error");
    expect(r.stateMachine.set("listening", { force: true })).toBe(true);
    r.setState("error");
    run(r, 3);
    expect(r.stateMachine.state).toBe("idle");
  });

  it("speaking enters automatically with speech and exits to idle; barge-in (listening) interrupts speech", async () => {
    const r = await makeRobot();
    const ends: boolean[] = [];
    r.on("speech:end", (e) => ends.push(e.interrupted));
    r.speak({ text: "Short.", tts: false });
    expect(r.stateMachine.state).toBe("speaking");
    run(r, 3);
    expect(r.stateMachine.state).toBe("idle");
    r.speak({ text: "A much longer sentence that goes on and on for quite a while.", tts: false });
    run(r, 0.5);
    r.setState("listening");
    expect(r.speaking).toBe(false);
    expect(ends).toEqual([false, true]);
    expect(r.stateMachine.state).toBe("listening");
  });
});

describe("JSON commands", () => {
  it("executes commands against the real engine and reports results with ids", async () => {
    const r = await makeRobot();
    const a = await executeCommand(r, { id: 7, cmd: "playAnimation", name: "greeting" });
    expect(a).toMatchObject({ ok: true, id: 7, cmd: "playAnimation" });
    expect((a.result as { accepted: string[] }).accepted).toContain("armR");
    await executeCommand(r, { cmd: "setEmotion", emotion: "surprised" });
    await executeCommand(r, { cmd: "moveHead", yaw: 25 });
    await executeCommand(r, { cmd: "setMouthOpen", value: 0.7 });
    run(r, 1.5);
    expect(morph(r, "Eye_L", "eyeSurprised")).toBeGreaterThan(0.8);
    expect(morph(r, "Mouth", "mouthOpen")).toBeCloseTo(0.7, 1);
    expect(r.joints.currentEuler("head").y).toBeGreaterThan(10);
    const st = await executeCommand(r, { cmd: "getStatus" });
    expect((st.result as { emotion: { name: string } }).emotion.name).toBe("surprised");
  });

  it("validates input and never throws", async () => {
    const r = await makeRobot();
    for (const bad of [
      { cmd: "setEmotion", emotion: "ecstatic" },
      { cmd: "moveHead", yaw: "left" },
      { cmd: "walkTo", x: 1 },
      { cmd: "playAnimation", name: "moonwalk" },
      { cmd: "dance" },
      { nocmd: true },
      "just a string",
      { cmd: "lookAt", target: { x: 1 } },
    ]) {
      const res = await executeCommand(r, bad);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      expect(res.error).toBeTypeOf("string");
    }
    expect((await executeMessage(r, "{not json")).error).toMatch(/invalid JSON/);
  });

  it("sequence waits for motion; parallel runs together; wait uses robot time", async () => {
    const r = await makeRobot();
    let t = 0;
    let done = false;
    const p = executeCommand(r, {
      cmd: "sequence",
      steps: [
        { cmd: "setEmotion", emotion: "happy" },
        { cmd: "walkTo", x: 0, z: 1 },
        { cmd: "wait", seconds: 0.5 },
        { cmd: "turn", to: 90 },
      ],
    }).then((res) => { done = true; return res; });
    for (; t < 600 && !done; t++) {
      r.update(1 / 60);
      if (t % 10 === 0) await flush();
    }
    const res = await p;
    expect(res.ok).toBe(true);
    expect(Math.abs(r.root.position.z - 1)).toBeLessThan(0.08);
    expect(Math.abs(r.root.rotation.y * 57.3 - 90)).toBeLessThan(4);

    const r2 = await makeRobot();
    const par = await executeCommand(r2, { cmd: "parallel", steps: [{ cmd: "moveHead", yaw: 10 }, { cmd: "setEmotion", emotion: "sad" }] });
    expect(par.ok).toBe(true);
    expect(r2.face.emotion.name).toBe("sad");
  });

  it("speak via JSON with wait resolves when speech ends", async () => {
    const r = await makeRobot();
    let res: unknown;
    void executeCommand(r, { cmd: "speak", text: "Hello there", tts: false, wait: true, emotion: "happy" }).then((x) => (res = x));
    for (let i = 0; i < 60 * 4; i++) {
      r.update(1 / 60);
      if (i % 20 === 0) await flush();
    }
    await flush();
    expect(res).toMatchObject({ ok: true });
    expect(r.speaking).toBe(false);
  });

  it("the transport bridge executes JSON frames, answers with results and streams events", async () => {
    const r = await makeRobot();
    const sent: string[] = [];
    let incoming: (d: string) => void = () => undefined;
    const transport: BridgeTransport = { send: (d) => sent.push(d), onMessage: (cb) => (incoming = cb) };
    const detach = attachBridge(r, transport);
    incoming(JSON.stringify({ id: "a1", cmd: "setState", state: "thinking" }));
    await flush();
    const frames = sent.map((s) => JSON.parse(s));
    expect(frames.find((f) => f.event === "state")).toMatchObject({ data: { to: "thinking" } });
    expect(frames.find((f) => f.id === "a1")).toMatchObject({ ok: true });
    incoming("garbage");
    await flush();
    expect(JSON.parse(sent[sent.length - 1])).toMatchObject({ ok: false });
    detach();
    const n = sent.length;
    r.setState("idle");
    expect(sent.length).toBe(n);
  });
});

describe("performance & resources", () => {
  it("a full frame (all layers + IK + morphs) is cheap enough for 60 FPS on the CPU side", async () => {
    const r = await makeRobot();
    r.speak({ text: "Performance check while walking and gesturing", tts: false });
    void r.walkTo({ x: 3, z: 3 });
    r.lookAt({ x: 1, y: 1.4, z: 2 });
    run(r, 1);
    const t0 = performance.now();
    const n = 600;
    for (let i = 0; i < n; i++) r.update(1 / 60);
    const ms = (performance.now() - t0) / n;
    expect(ms).toBeLessThan(2.5); // generous vs the 16.6 ms budget; real value is printed below
    console.log(`engine update: ${ms.toFixed(3)} ms/frame`);
  });

  it("dispose releases geometries and materials without throwing", async () => {
    const r = await makeRobot();
    run(r, 0.2);
    expect(() => r.dispose()).not.toThrow();
  });
});
