import * as THREE from "three";
import { RobotAvatar, type ColorPart } from "../engine/RobotAvatar";
import { BRAND_PRESETS, DEFAULT_BRAND } from "./brands";
import { RobotViewer, type BackgroundPreset, type CameraPreset, type LobbyBrand, type QualityLevel } from "../viewer/RobotViewer";
import { JOINT_DEFS, REQUIRED_BONES } from "../engine/rig";

export type Style = "friendly" | "futuristic" | "premium" | "concierge" | "mascot";
export type GazeMode = "free" | "cursor" | "camera";

export interface BrandState {
  preset: string | null;
  colors: Partial<Record<ColorPart, string>>;
  logo: string | null;
  /** sign / desk branding of the lobby (kept while colours are edited) */
  lobby: LobbyBrand | null;
  logoSize: number;
  placement: "auto" | "center" | "left";
}

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
  private raycaster = new THREE.Raycaster();
  listeners = new Set<() => void>();
  /** starts with the Al-Razi University identity (Brand tab: "Original" removes it) */
  brand: BrandState = (() => {
    const p = BRAND_PRESETS[DEFAULT_BRAND];
    return {
      preset: DEFAULT_BRAND, colors: p.colors, logo: assetUrl(p.logo!), logoSize: 0.11, placement: "auto" as const,
      lobby: p.lobby ? { ...p.lobby, logo: assetUrl(p.logo!) } : null,
    };
  })();
  onBoneSelected?: (bone: string) => void;

  async init(container: HTMLElement) {
    this.viewer = new RobotViewer(container, { quality: "high", background: "lobby", preserveDrawingBuffer: true });
    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffc247, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.marker.renderOrder = 999;
    this.marker.visible = false;
    this.viewer.scene.add(this.marker);
    this.viewer.onFrame.push(() => this.afterFrame());
    await this.loadStyle(this.style);
    this.viewer.setCameraPreset("full", false);
    this.viewer.start();
    this.bindPointer();
    const w = window as unknown as Record<string, unknown>;
    w.studio = this;
    w.viewer = this.viewer;
  }

  async loadStyle(style: Style) {
    const prev = this.robot;
    const pos = prev?.root.position.clone();
    const yaw = prev?.root.rotation.y ?? 0;
    const robot = await RobotAvatar.load(modelUrl(style));
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
    robot.on("walk:route", (e) => this.showRoute(e.points));
    robot.on("walk:end", () => this.hideRoute());
    robot.on("*" as never, ((e: { type: string; data: unknown }) => this.pushLog(e.type, e.data)) as never);
    this.viewer.add(robot);
    this.applyGaze();
    (window as unknown as Record<string, unknown>).robot = robot;
    await this.applyBrand(this.brand, true);
    this.emitChange();
  }

  private routeLine: THREE.Mesh | null = null;
  /** draw the planned walking route on the floor (around furniture), removed when the walk ends */
  private showRoute(points: { x: number; z: number }[]) {
    this.hideRoute();
    if (points.length < 2) return;
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < points.length; i++) {
      path.add(new THREE.LineCurve3(new THREE.Vector3(points[i - 1].x, 0.03, points[i - 1].z), new THREE.Vector3(points[i].x, 0.03, points[i].z)));
    }
    const g = new THREE.TubeGeometry(path, Math.max(8, points.length * 24), 0.014, 6, false);
    const m = new THREE.MeshBasicMaterial({ color: 0x59d0ff, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false });
    const line = new THREE.Mesh(g, m);
    line.renderOrder = 998;
    this.routeLine = line;
    this.viewer.scene.add(line);
  }
  private hideRoute() {
    if (!this.routeLine) return;
    this.routeLine.removeFromParent();
    this.routeLine.geometry.dispose();
    (this.routeLine.material as THREE.Material).dispose();
    this.routeLine = null;
  }

  pushLog(type: string, data: unknown) {
    this.log.push({ t: performance.now() / 1000, type, data });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  /** colours + chest logo; kept when switching styles */
  async applyBrand(next: Partial<BrandState>, force = false) {
    const prev = this.brand;
    this.brand = { ...prev, ...next };
    const b = this.brand;
    const r = this.robot;
    r.resetColors();
    r.setColors(b.colors);
    if (JSON.stringify(b.lobby) !== JSON.stringify(prev.lobby) || force) void this.viewer.setLobbyBrand(b.lobby); // not on every colour tweak
    if (force || b.logo !== prev.logo || b.logoSize !== prev.logoSize || b.placement !== prev.placement || !r.hasLogo !== !b.logo) {
      const size = b.placement === "left" || (b.placement === "auto" && r.parts.materials.has("Mat_Uniform")) ? b.logoSize * 0.68 : b.logoSize;
      await r.setLogo(b.logo, { size, placement: b.placement === "auto" ? undefined : b.placement });
    }
    this.emitChange();
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
    return [...this.robot.parts.meshes.values()].filter((m) => !/^(Eye|Mouth|Brow)/.test(m.name) || true);
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
    this.cleanup.forEach((f) => f());
    this.viewer?.dispose();
  }
}
