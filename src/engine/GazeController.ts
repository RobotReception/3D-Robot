import * as THREE from "three";
import { EYE_TRAVEL, eulerToQuat, type JointSpace } from "./rig";

export type GazeTarget = THREE.Vector3 | (() => THREE.Vector3) | null;
const DEG = Math.PI / 180;
const damp = (cur: number, tgt: number, tau: number, dt: number) => cur + (tgt - cur) * (1 - Math.exp(-dt / tau));

/**
 * Look-at with eye-leads-head behaviour: eyes saccade quickly to the target, then the
 * head/neck follow with a slower spring and take most of the angle; eyes keep only the
 * remainder. Adds micro-saccades and an optional idle wander so the face never freezes.
 */
export class GazeController {
  target: GazeTarget = null;
  /** random idle glances when no target is set */
  idleWander = true;
  /** fraction of the angle taken by the head (rest goes to the eyes) */
  headShare = 0.7;
  enabled = true;
  /** manual eye direction in degrees (yaw + = toward the character's left, pitch + = up); null = follow the look-at target */
  manualEyes: { yaw: number; pitch: number } | null = null;

  private eyeYaw = 0;
  private eyePitch = 0;
  private headYaw = 0;
  private headPitch = 0;
  private wanderYaw = 0;
  private wanderPitch = 0;
  private wanderTimer = 2;
  private saccadeYaw = 0;
  private saccadePitch = 0;
  private saccadeTimer = 1;
  rng: () => number = Math.random;

  /** current look angles in degrees (for UI / tests) */
  get angles() {
    return { headYaw: this.headYaw, headPitch: this.headPitch, eyeYaw: this.eyeYaw, eyePitch: this.eyePitch };
  }

  constructor(private joints: JointSpace) {}

  setTarget(t: GazeTarget) {
    this.target = t;
  }

  /** @param headWorld the head's pivot in world space (to compute the aim direction) */
  update(dt: number, headWorld: THREE.Vector3) {
    if (!this.enabled) return;
    const c = this.joints.container;
    let tyaw = 0;
    let tpitch = 0;
    const tgt = typeof this.target === "function" ? this.target() : this.target;
    if (tgt) {
      const v = c.worldToLocal(tgt.clone()).sub(c.worldToLocal(headWorld.clone()));
      tyaw = Math.atan2(v.x, v.z) / DEG;
      tpitch = Math.atan2(v.y, Math.hypot(v.x, v.z)) / DEG;
      // targets behind the robot: keep the head forward-ish instead of wrapping around
      if (Math.abs(tyaw) > 100) tyaw = Math.sign(tyaw) * 100;
    } else if (this.idleWander) {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 2.5 + this.rng() * 4;
        this.wanderYaw = (this.rng() - 0.5) * 2 * 16;
        this.wanderPitch = (this.rng() - 0.5) * 2 * 6 - 1;
      }
      tyaw = this.wanderYaw;
      tpitch = this.wanderPitch;
    }
    // micro saccades
    this.saccadeTimer -= dt;
    if (this.saccadeTimer <= 0) {
      this.saccadeTimer = 0.6 + this.rng() * 2.2;
      this.saccadeYaw = (this.rng() - 0.5) * 3.2;
      this.saccadePitch = (this.rng() - 0.5) * 2.2;
    }

    const hy = THREE.MathUtils.clamp(tyaw * this.headShare, -62, 62);
    const hp = THREE.MathUtils.clamp(tpitch * this.headShare, -22, 28);
    this.headYaw = damp(this.headYaw, hy, 0.2, dt);
    this.headPitch = damp(this.headPitch, hp, 0.2, dt);
    let ey = THREE.MathUtils.clamp(tyaw - this.headYaw, -EYE_TRAVEL.maxYaw, EYE_TRAVEL.maxYaw) + this.saccadeYaw;
    let ep = THREE.MathUtils.clamp(tpitch - this.headPitch, -EYE_TRAVEL.maxPitch, EYE_TRAVEL.maxPitch) + this.saccadePitch;
    if (this.manualEyes) {
      ey = this.manualEyes.yaw;
      ep = this.manualEyes.pitch;
    }
    this.eyeYaw = damp(this.eyeYaw, ey, 0.055, dt);
    this.eyePitch = damp(this.eyePitch, ep, 0.055, dt);

    // head 65% / neck 35% of the head angle; sign: +pitch = look up = negative X rotation
    const q = new THREE.Quaternion();
    this.joints.applyDelta("head", eulerToQuat({ x: -this.headPitch * 0.65, y: this.headYaw * 0.65, z: 0 }, "YXZ", q));
    this.joints.applyDelta("neck", eulerToQuat({ x: -this.headPitch * 0.35, y: this.headYaw * 0.35, z: 0 }, "YXZ", q));
    const off = new THREE.Vector3(
      THREE.MathUtils.clamp(this.eyeYaw / EYE_TRAVEL.maxYaw, -1, 1) * EYE_TRAVEL.x,
      THREE.MathUtils.clamp(this.eyePitch / EYE_TRAVEL.maxPitch, -1, 1) * EYE_TRAVEL.y,
      0,
    );
    for (const s of ["L", "R"]) this.joints.setPositionOffset(`eye_${s}`, off);
  }
}
