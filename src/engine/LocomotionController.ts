import * as THREE from "three";
import { applyLimbIK, limbRest, setClampedDelta, type LimbDef, type LimbRest } from "./ik";
import type { JointSpace, Side } from "./rig";

const UP = new THREE.Vector3(0, 1, 0);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const DEG = Math.PI / 180;
const ease = (u: number) => u * u * (3 - 2 * u);

export type LocomotionState = "idle" | "walking" | "turning";

interface Swing {
  t: number;
  dur: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromYaw: number;
  toYaw: number;
  height: number;
}
interface Foot {
  side: Side;
  def: LimbDef;
  rest: LimbRest;
  hipLocal: THREE.Vector3; // rest hip position (container space)
  ankleY: number;
  planted: THREE.Vector3; // world
  plantedYaw: number; // world yaw (rad)
  swing: Swing | null;
}

export interface WalkOptions {
  /** m/s, default 0.8 */
  speed?: number;
  /** final facing in degrees (world yaw, 0 = +Z) after arriving */
  facing?: number;
  /** arrival tolerance in meters */
  tolerance?: number;
}

/**
 * Procedural, IK-planted locomotion.
 *
 * The avatar container moves/yaws on the ground; each foot is *planted in world space*
 * during stance (no sliding) and re-placed ahead of the body by a stepping state machine
 * (swing arc + landing prediction). Legs are solved with analytic two-bone IK and the
 * pelvis drops just enough that both feet stay reachable, so squats, bounces and
 * weight shifts authored on the pelvis keep the feet on the floor (balance).
 */
export class LocomotionController {
  state: LocomotionState = "idle";
  readonly feet: Record<Side, Foot>;
  maxSpeed = 0.9;
  private v = 0; // current forward speed
  private vTarget = 0;
  private omega = 0; // yaw rate rad/s
  private goal: { x: number; z: number; opts: WalkOptions } | null = null;
  private turnGoal: number | null = null; // world yaw rad
  private continuous = false;
  private resolve: ((ok: boolean) => void) | null = null;
  private stepCount = 0;
  private stepTimer = 0;
  private swingSide: Side = "L";
  private settling = false;
  private drop = 0;
  private legLen: number;
  /** gait phase 0..2 (one stride), for arm swing */
  phase = 0;
  private pole = new THREE.Vector3(0, 0.1, 1).normalize();

  constructor(private joints: JointSpace, private container: THREE.Object3D) {
    container.updateMatrixWorld(true);
    const mk = (side: Side): Foot => {
      const def: LimbDef = { upper: `thigh_${side}`, lower: `shin_${side}`, end: `foot_${side}` };
      const hip = joints.restWorldPos(def.upper).clone();
      return {
        side, def, rest: limbRest(joints, def), hipLocal: hip,
        ankleY: joints.restWorldPos(def.end).y,
        planted: new THREE.Vector3(), plantedYaw: 0, swing: null,
      };
    };
    this.feet = { L: mk("L"), R: mk("R") };
    this.legLen = this.feet.L.rest.l1 + this.feet.L.rest.l2;
    this.maxSpeed = Math.min(0.9, 1.7 * this.legLen); // short-legged characters walk slower
    this.plantFeetNeutral();
  }

  get yaw() {
    return this.container.rotation.y;
  }
  get position() {
    return this.container.position;
  }
  get speed() {
    return this.v;
  }
  get busy() {
    return this.state !== "idle" || this.settling;
  }

  /** place both feet at the neutral stance under the current body pose */
  plantFeetNeutral() {
    this.container.updateMatrixWorld(true);
    for (const f of Object.values(this.feet)) {
      f.planted.set(f.hipLocal.x, f.ankleY, f.hipLocal.z);
      this.container.localToWorld(f.planted);
      f.plantedYaw = this.yaw;
      f.swing = null;
    }
    this.settling = false;
  }

  // ---- commands
  walkTo(x: number, z: number, opts: WalkOptions = {}): Promise<boolean> {
    this.cancel(false);
    this.goal = { x, z, opts };
    this.state = "walking";
    this.continuous = false;
    return new Promise((res) => (this.resolve = res));
  }
  /** walk straight ahead until stop() */
  walkForward(speed = 0.7) {
    this.cancel(false);
    this.state = "walking";
    this.continuous = true;
    this.goal = null;
    this.vTarget = Math.min(speed, this.maxSpeed);
  }
  turnTo(worldYawDeg: number): Promise<boolean> {
    this.cancel(false);
    this.turnGoal = worldYawDeg * DEG;
    this.state = "turning";
    return new Promise((res) => (this.resolve = res));
  }
  turnBy(deg: number): Promise<boolean> {
    return this.turnTo(this.yaw / DEG + deg);
  }
  /** hard stop (no deceleration, no settling steps): used by resetPose */
  halt() {
    this.cancel(false);
    this.v = 0;
    this.vTarget = 0;
    this.omega = 0;
    this.state = "idle";
    this.settling = false;
    this.stepCount = 0;
    this.drop = 0;
    this.plantFeetNeutral();
  }
  /** stop moving; feet settle side by side */
  stop() {
    this.cancel(true);
  }
  private cancel(settle: boolean) {
    const r = this.resolve;
    this.resolve = null;
    this.goal = null;
    this.turnGoal = null;
    this.continuous = false;
    this.vTarget = 0;
    if (settle && this.state !== "idle") this.settling = true;
    if (this.state !== "idle" && !settle) {
      /* new command replaces the old one, keep stepping */
    }
    r?.(false);
  }

  // ---- per-frame
  update(dt: number) {
    dt = Math.min(dt, 0.05);
    this.drive(dt);
    this.stepFeet(dt);
    this.solveLegs(dt);
  }

  private drive(dt: number) {
    let wantOmega = 0;
    let vT = this.vTarget;
    const pos = this.container.position;
    if (this.goal) {
      const dx = this.goal.x - pos.x;
      const dz = this.goal.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const tol = this.goal.opts.tolerance ?? 0.05;
      const cruise = Math.min(this.goal.opts.speed ?? 0.8, this.maxSpeed);
      if (dist <= tol) {
        const facing = this.goal.opts.facing;
        const res = this.resolve;
        this.goal = null;
        this.vTarget = 0;
        vT = 0;
        if (facing !== undefined) {
          this.turnGoal = facing * DEG;
          this.state = "turning";
        } else {
          this.finishMotion();
        }
        this.resolve = facing !== undefined ? res : null;
        if (facing === undefined) res?.(true);
      } else {
        const err = wrap(Math.atan2(dx, dz) - this.yaw);
        wantOmega = THREE.MathUtils.clamp(err * 3.5, -1.5, 1.5);
        const align = Math.abs(err);
        vT = align > 0.6 ? 0 : Math.min(cruise, Math.max(0.12, dist * 1.8)) * (1 - align / 0.9);
        if (vT < 0.05 && align <= 0.6) vT = 0.1;
        this.state = "walking";
      }
    }
    if (this.turnGoal !== null && !this.goal) {
      const err = wrap(this.turnGoal - this.yaw);
      if (Math.abs(err) < 0.02 && Math.abs(this.omega) < 0.15) {
        this.turnGoal = null;
        const res = this.resolve;
        this.resolve = null;
        this.finishMotion();
        res?.(true);
      } else {
        wantOmega = THREE.MathUtils.clamp(err * 3.2, -1.35, 1.35);
        if (Math.abs(wantOmega) < 0.25) wantOmega = 0.25 * Math.sign(err || 1);
      }
    }
    if (this.continuous) vT = this.vTarget;
    this.vTarget = this.goal || this.continuous ? vT : 0;
    // accelerate smoothly
    const acc = 1.6;
    this.v += THREE.MathUtils.clamp(vT - this.v, -acc * dt, acc * dt);
    if (this.v < 1e-3 && vT === 0) this.v = 0;
    this.omega += (wantOmega - this.omega) * (1 - Math.exp(-dt / 0.12));
    if (Math.abs(this.omega) < 1e-4) this.omega = 0;
    this.container.rotation.y = wrap(this.yaw + this.omega * dt);
    pos.x += Math.sin(this.yaw) * this.v * dt;
    pos.z += Math.cos(this.yaw) * this.v * dt;
  }

  private finishMotion() {
    if (this.state !== "idle") this.settling = true;
    this.state = "idle";
  }

  private moving() {
    return this.v > 0.02 || Math.abs(this.omega) > 0.04 || this.goal !== null || this.turnGoal !== null || this.continuous;
  }

  private stepFeet(dt: number) {
    const moving = this.moving();
    const sp = this.v / this.maxSpeed;
    const tStep = this.state === "turning" ? 0.46 : 0.52 - 0.15 * sp;
    // advance swings
    for (const f of Object.values(this.feet)) {
      if (!f.swing) continue;
      f.swing.t += dt;
      if (f.swing.t >= f.swing.dur) {
        f.planted.copy(f.swing.to);
        f.plantedYaw = f.swing.toYaw;
        f.swing = null;
      }
    }
    const swinging = this.feet.L.swing || this.feet.R.swing;
    if (!swinging) {
      this.stepTimer -= dt;
      if (moving || this.settling) {
        if (this.stepTimer <= 0) this.startStep(tStep, !moving);
      } else {
        this.stepTimer = 0;
        this.phase = 0;
        this.stepCount = 0;
        if (this.state !== "idle" && !this.goal && this.turnGoal === null) this.state = "idle";
      }
    }
    const sw = this.feet[this.swingSide].swing;
    const u = sw ? sw.t / sw.dur : 1;
    this.phase = (this.stepCount + u) % 2;
  }

  private startStep(tStep: number, settle: boolean) {
    const side = this.swingSide;
    const f = this.feet[side];
    const other = this.feet[side === "L" ? "R" : "L"];
    const tSwing = tStep * 0.88;
    // predicted body pose at landing
    const yawL = this.yaw + this.omega * tSwing;
    const pos = this.container.position;
    const pL = new THREE.Vector3(pos.x + Math.sin(this.yaw) * this.v * tSwing, pos.y, pos.z + Math.cos(this.yaw) * this.v * tSwing);
    const stepLen = settle ? 0 : Math.min(this.v * tStep, this.legLen * 0.62);
    const local = new THREE.Vector3(f.hipLocal.x, f.ankleY, f.hipLocal.z + stepLen * 0.5);
    const to = local.clone().applyAxisAngle(UP, yawL).add(pL);
    to.y = f.ankleY;
    const dist = to.distanceTo(f.planted);
    if (settle && dist < 0.012 && Math.abs(wrap(yawL - f.plantedYaw)) < 0.03) {
      // already neutral: finish settling once both feet are home
      const od = new THREE.Vector3(other.hipLocal.x, other.ankleY, other.hipLocal.z).applyAxisAngle(UP, yawL).add(pL);
      od.y = other.ankleY;
      if (od.distanceTo(other.planted) < 0.02) {
        this.settling = false;
        this.stepCount = 0;
        return;
      }
      this.swingSide = side === "L" ? "R" : "L";
      return;
    }
    f.swing = {
      t: 0, dur: tSwing, from: f.planted.clone(), to, fromYaw: f.plantedYaw, toYaw: yawL,
      height: 0.028 + 0.05 * Math.min(1, Math.max(this.v / this.maxSpeed, Math.abs(this.omega) / 1.2)) + Math.min(0.03, dist * 0.2),
    };
    this.swingSide = side === "L" ? "R" : "L";
    this.stepCount++;
    this.stepTimer = tStep - tSwing;
  }

  private footTarget(f: Foot, out: THREE.Vector3): { yaw: number; pitch: number } {
    if (!f.swing) {
      out.copy(f.planted);
      return { yaw: f.plantedYaw, pitch: 0 };
    }
    const s = f.swing;
    const u = Math.min(1, s.t / s.dur);
    out.lerpVectors(s.from, s.to, ease(u));
    out.y = f.ankleY + s.height * Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.98 + 0.01)), 0.85);
    const pitch = -10 * (1 - ease(Math.min(1, u * 3))) + 8 * ease(Math.max(0, (u - 0.7) / 0.3));
    return { yaw: s.fromYaw + wrap(s.toYaw - s.fromYaw) * ease(u), pitch };
  }

  private solveLegs(dt: number) {
    const c = this.container;
    const j = this.joints;
    const pelvis = j.bone("pelvis");
    // gait-driven pelvis sway (shift over the stance foot)
    if (this.v > 0.05 || this.moving()) {
      const sp = Math.min(1, this.v / this.maxSpeed);
      const stance = this.swingSide === "L" ? 1 : -1; // swingSide already toggled: the *next* swinger is the stance leg
      const sway = 0.012 * (0.4 + sp) * stance * (this.feet.L.swing || this.feet.R.swing ? 1 : 0);
      const off = j.positionOffset("pelvis");
      off.x += sway;
      j.setPositionOffset("pelvis", off);
    }
    c.updateMatrixWorld(true);
    const targets: Record<Side, { p: THREE.Vector3; yaw: number; pitch: number }> = {
      L: { p: new THREE.Vector3(), yaw: 0, pitch: 0 },
      R: { p: new THREE.Vector3(), yaw: 0, pitch: 0 },
    };
    let needDrop = 0;
    for (const side of ["L", "R"] as Side[]) {
      const f = this.feet[side];
      const t = targets[side];
      const r = this.footTarget(f, t.p);
      t.yaw = r.yaw - this.yaw;
      t.pitch = r.pitch;
      c.worldToLocal(t.p);
      const hip = j.bone(f.def.upper).getWorldPosition(new THREE.Vector3());
      c.worldToLocal(hip);
      const dxz = Math.hypot(t.p.x - hip.x, t.p.z - hip.z);
      const lmax = this.legLen * 0.985;
      const maxHipY = t.p.y + Math.sqrt(Math.max(0.0004, lmax * lmax - dxz * dxz));
      needDrop = Math.max(needDrop, hip.y - maxHipY);
    }
    needDrop = Math.max(0, needDrop);
    // drop immediately when feet would be out of reach, release slowly (no popping)
    this.drop = needDrop > this.drop ? needDrop : this.drop + (needDrop - this.drop) * (1 - Math.exp(-dt / 0.12));
    const applied = this.drop;
    const off = j.positionOffset("pelvis");
    off.y -= applied;
    j.setPositionOffset("pelvis", off);
    c.updateMatrixWorld(true);
    pelvis.updateMatrixWorld(true);

    const parentDelta = j.worldDelta("pelvis");
    const q = new THREE.Quaternion();
    for (const side of ["L", "R"] as Side[]) {
      const f = this.feet[side];
      const t = targets[side];
      const hip = j.bone(f.def.upper).getWorldPosition(new THREE.Vector3());
      c.worldToLocal(hip);
      const pole = this.pole.clone();
      const res = applyLimbIK(j, f.def, f.rest, hip, t.p, pole, parentDelta);
      // keep the foot flat relative to the ground (yaw follows the planted yaw)
      const desired = new THREE.Quaternion()
        .setFromAxisAngle(UP, t.yaw)
        .multiply(q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), t.pitch * DEG));
      const dFoot = res.worldLower.clone().invert().multiply(desired);
      setClampedDelta(j, `foot_${side}`, dFoot);
      // toe follows heel lift lightly
      const toe = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.max(0, -t.pitch) * 0.5 * DEG);
      setClampedDelta(j, `toe_${side}`, toe);
    }
  }

  /** Arm swing / torso counter-rotation values for the current gait (degrees), used by RobotAvatar. */
  gaitSwing() {
    const sp = Math.min(1, this.v / this.maxSpeed);
    const th = Math.PI * this.phase;
    return {
      amount: sp,
      armR: 24 * sp * Math.sin(th - Math.PI / 2),
      armL: -24 * sp * Math.sin(th - Math.PI / 2),
      spineYaw: 4 * sp * Math.sin(th - Math.PI / 2),
      lean: 3 * sp,
    };
  }

  /** world-space positions of the ankle targets (tests/debug) */
  footWorld(side: Side) {
    const f = this.feet[side];
    const out = new THREE.Vector3();
    this.footTarget(f, out);
    return out;
  }
  isPlanted(side: Side) {
    return !this.feet[side].swing;
  }
}
