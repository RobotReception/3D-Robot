import * as THREE from "three";
import { RobotAvatar } from "../engine/RobotAvatar";
import { RobotViewer, type BackgroundPreset, type CameraPreset, type QualityLevel } from "../viewer/RobotViewer";
import { JOINT_DEFS, REQUIRED_BONES } from "../engine/rig";

export type Style = "friendly" | "futuristic" | "premium" | "concierge" | "mascot";
export type GazeMode = "free" | "cursor" | "camera";

export interface LogEntry {
  t: number;
  type: string;
  data: unknown;
}

const modelUrl = (s: Style) => `${import.meta.env.BASE_URL}models/robot_${s}.glb`;
export const assetUrl = (p: string) => `${import.meta.env.BASE_URL}${p.replace(/^\//, "")}`;

/** Non-React core of the Control Studio: owns the viewer + robot and the cross-panel state. */
export class StudioCore {
  viewer!: RobotViewer;
  robot!: RobotAvatar;
  style: Style = "concierge";
  selectedBone: string | null = null;
  gazeMode: GazeMode = "free";
  log: LogEntry[] = [];
  engineMs = 0;
  private engineAcc = 0;
  private engineN = 0;
  private marker!: THREE.Mesh;
  private cursorTarget = new THREE.Vector3(0, 1.4, 2);
  private cleanup: (() => void)[] = [];
  private disposed = false;
  private loadVersion = 0;
  private raycaster = new THREE.Raycaster();
  listeners = new Set<() => void>();
  onBoneSelected?: (bone: string) => void;

  async init(container: HTMLElement) {
    this.viewer = new RobotViewer(container, { quality: "high", preserveDrawingBuffer: true });
    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffc247, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.marker.renderOrder = 999;
    this.marker.visible = false;
    this.viewer.scene.add(this.marker);
    this.viewer.onFrame.push(() => this.afterFrame());
    await this.loadStyle(this.style);
    if (this.disposed) return;
    this.viewer.setCameraPreset("full", false);
    this.viewer.start();
    this.bindPointer();
    const w = window as unknown as Record<string, unknown>;
    w.studio = this;
    w.viewer = this.viewer;
  }

  async loadStyle(style: Style) {
    if (this.disposed) return;
    const version = ++this.loadVersion;
    let robot: RobotAvatar;
    try {
      robot = await RobotAvatar.load(modelUrl(style), { autoBlink: false, eyeGlow: false });
    } catch (error) {
      if (this.disposed || version !== this.loadVersion) return;
      if (!this.robot) throw error;
      this.pushLog("error", { message: String(error) });
      this.emitChange();
      return;
    }
    if (this.disposed || version !== this.loadVersion) {
      robot.dispose();
      return;
    }
    const prev = this.robot;
    const pos = prev?.root.position.clone();
    const yaw = prev?.root.rotation.y ?? 0;
    if (prev) {
      this.viewer.remove(prev);
      prev.dispose();
    }
    this.robot = robot;
    if (pos) robot.root.position.copy(pos);
    robot.root.rotation.y = yaw;
    this.style = style;
    // measure CPU time of the engine update
    const orig = robot.update.bind(robot);
    robot.update = (dt: number) => {
      const t0 = performance.now();
      orig(dt);
      this.engineAcc += performance.now() - t0;
      if (++this.engineN >= 30) {
        this.engineMs = this.engineAcc / this.engineN;
        this.engineAcc = 0;
        this.engineN = 0;
      }
    };
    robot.on("*" as never, ((e: { type: string; data: unknown }) => this.pushLog(e.type, e.data)) as never);
    this.viewer.add(robot);
    this.applyGaze();
    (window as unknown as Record<string, unknown>).robot = robot;
    this.emitChange();
  }

  pushLog(type: string, data: unknown) {
    this.log.push({ t: performance.now() / 1000, type, data });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emitChange() {
    this.listeners.forEach((f) => f());
  }

  // ---- viewer shortcuts
  setQuality(q: QualityLevel) {
    this.viewer.setQuality(q);
    this.emitChange();
  }
  setBackground(b: BackgroundPreset) {
    this.viewer.setBackground(b);
    this.emitChange();
  }
  setCamera(p: CameraPreset) {
    this.viewer.setCameraPreset(p, true, this.robot);
  }

  // ---- gaze
  setGazeMode(m: GazeMode) {
    this.gazeMode = m;
    this.applyGaze();
    this.emitChange();
  }
  private applyGaze() {
    const r = this.robot;
    if (!r) return;
    r.stateMachine.userTarget = null;
    if (this.gazeMode === "camera") r.lookAt(this.viewer.camera);
    else if (this.gazeMode === "cursor") r.lookAt(this.cursorTarget);
    else r.lookAt(null);
    r.gaze.idleWander = this.gazeMode === "free";
  }

  // ---- joint selection (click the robot)
  selectBone(bone: string | null) {
    this.selectedBone = bone;
    this.marker.visible = !!bone;
    this.emitChange();
    if (bone) this.onBoneSelected?.(bone);
  }

  private pickable() {
    return [...this.robot.parts.meshes.values()];
  }

  private bindPointer() {
    const canvas = this.viewer.canvas;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      this.pick(e);
    };
    const onMove = (e: PointerEvent) => {
      if (this.gazeMode !== "cursor") return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.viewer.camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.robot.root.rotation.y));
      const fwd = new THREE.Vector3(0, 0, 1.8).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.robot.root.rotation.y).add(this.robot.root.position);
      plane.constant = -plane.normal.dot(fwd);
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, hit)) this.cursorTarget.copy(hit);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointermove", onMove);
    this.cleanup.push(() => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
    });
  }

  private pick(e: PointerEvent) {
    const rect = this.viewer.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const hits = this.raycaster.intersectObjects(this.pickable(), false);
    if (!hits.length) return this.selectBone(null);
    const p = hits[0].point;
    const candidates = this.robot.listJoints().map((j) => j.bone);
    let best = candidates[0];
    let bd = Infinity;
    for (const b of candidates) {
      const d = this.robot.joints.bone(b).getWorldPosition(new THREE.Vector3()).distanceTo(p);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    this.selectBone(best);
  }

  private afterFrame() {
    if (this.selectedBone && this.marker.visible) {
      this.marker.position.copy(this.robot.joints.bone(this.selectedBone).getWorldPosition(new THREE.Vector3()));
    }
    if (this.gazeMode === "cursor" && this.robot) {
      // target vector updated in place; GazeController reads it each frame
    }
  }

  jointLabel(bone: string) {
    const m = /^(.*?)(?:_(L|R))?$/.exec(bone)!;
    const base = m[1].replace(/_\d$/, "");
    const def = JOINT_DEFS.find((d) => d.id === m[1]) ?? JOINT_DEFS.find((d) => d.id === base);
    return `${def?.label ?? bone}${m[2] ? " " + m[2] : ""}`;
  }

  get boneCount() {
    return REQUIRED_BONES.length;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.loadVersion;
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.listeners.clear();
    this.marker?.geometry.dispose();
    (this.marker?.material as THREE.Material | undefined)?.dispose();
    this.viewer?.dispose();
  }
}
