import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import type { RobotAvatar } from "../engine/RobotAvatar";

export type QualityLevel = "low" | "medium" | "high";
export type CameraPreset = "full" | "upper" | "face" | "side" | "back";
export type BackgroundPreset = "studio" | "light" | "dusk" | "green" | "transparent";

export class WebGLUnavailableError extends Error {
  constructor(msg = "WebGL is not available on this device/browser") {
    super(msg);
  }
}

export function webglSupported(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

const QUALITY: Record<QualityLevel, { pixelRatio: number; shadows: boolean; shadowMap: number; envIntensity: number; toneMapping: THREE.ToneMapping; bloom: boolean }> = {
  low: { pixelRatio: 1, shadows: false, shadowMap: 512, envIntensity: 0.7, toneMapping: THREE.LinearToneMapping, bloom: false },
  medium: { pixelRatio: 1.5, shadows: true, shadowMap: 1024, envIntensity: 0.9, toneMapping: THREE.ACESFilmicToneMapping, bloom: false },
  high: { pixelRatio: 2, shadows: true, shadowMap: 2048, envIntensity: 1, toneMapping: THREE.ACESFilmicToneMapping, bloom: true },
};
const BACKGROUNDS: Record<BackgroundPreset, { color: string | null; floor: string }> = {
  studio: { color: "#10131a", floor: "#1b2030" },
  light: { color: "#dfe5ee", floor: "#cfd6e2" },
  dusk: { color: "#2b2147", floor: "#3a2c5c" },
  green: { color: "#0f2a22", floor: "#173a30" },
  transparent: { color: null, floor: "#1b2030" },
};

export interface ViewerStats {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
}

export interface ViewerOptions {
  quality?: QualityLevel;
  background?: BackgroundPreset;
  /** pass an existing canvas (otherwise one is created and appended to `container`) */
  canvas?: HTMLCanvasElement;
  preserveDrawingBuffer?: boolean;
}

/**
 * three.js viewer: renderer, camera, lights, PBR environment, floor and orbit controls.
 * Independent of React; the Control Studio and any other host use the same class.
 */
export class RobotViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.05, 60);
  readonly controls: OrbitControls;
  readonly canvas: HTMLCanvasElement;
  private avatars = new Set<RobotAvatar>();
  private key = new THREE.DirectionalLight(0xffffff, 2.4);
  private fill = new THREE.DirectionalLight(0x9db8ff, 0.7);
  private rim = new THREE.DirectionalLight(0xffd9b0, 1.2);
  private floor: THREE.Mesh;
  private ring: THREE.Mesh;
  private grid: THREE.GridHelper;
  private envTex: THREE.Texture;
  private bloomComposer: EffectComposer | null = null;
  private finalComposer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private darkMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private stash = new Map<THREE.Object3D, THREE.Material | THREE.Material[]>();
  private bloomLayer = new THREE.Layers();
  /** glow (bloom) on emissive parts: eyes, mouth, ring joints. On by default in "high". */
  bloom = false;
  private pmrem: THREE.PMREMGenerator;
  private raf = 0;
  private last = 0;
  private running = false;
  private ro: ResizeObserver | null = null;
  private camTween: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number; dur: number } | null = null;
  private frames = 0;
  private fpsAcc = 0;
  private _stats: ViewerStats = { fps: 0, frameMs: 0, calls: 0, triangles: 0, geometries: 0, textures: 0, pixelRatio: 1 };
  private frameMsAcc = 0;
  quality: QualityLevel = "high";
  background: BackgroundPreset = "studio";
  /** current lighting values (read by the Studio sliders) */
  light = { intensity: 2.4, angleDeg: 31, exposure: 1.05, grid: true };
  onFrame: ((dt: number) => void)[] = [];
  /** follow the robot with the orbit target (face/upper presets) */
  followTarget: (() => THREE.Vector3) | null = null;

  constructor(readonly container: HTMLElement, o: ViewerOptions = {}) {
    this.bloomLayer.set(1);
    if (!webglSupported()) throw new WebGLUnavailableError();
    this.canvas = o.canvas ?? document.createElement("canvas");
    this.canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none";
    if (!o.canvas) container.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: true, powerPreference: "high-performance",
      preserveDrawingBuffer: o.preserveDrawingBuffer ?? false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false; // multi-pass frames (bloom): reset once per frame so stats cover all passes
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // PBR environment (procedural room, no external HDR needed)
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTex = this.pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    this.scene.environment = this.envTex;

    this.key.position.set(2.5, 4, 3);
    this.key.castShadow = true;
    this.key.shadow.camera.left = -2;
    this.key.shadow.camera.right = 2;
    this.key.shadow.camera.top = 2.5;
    this.key.shadow.camera.bottom = -1;
    this.key.shadow.camera.near = 0.5;
    this.key.shadow.camera.far = 12;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.fill.position.set(-3, 1.5, 2);
    this.rim.position.set(-1.5, 3, -3.5);
    this.scene.add(this.key, this.fill, this.rim);

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1b2030, roughness: 0.85, metalness: 0.1 });
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.64, 96),
      new THREE.MeshBasicMaterial({ color: 0x59d0ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.002;
    this.grid = new THREE.GridHelper(12, 24, 0x39425a, 0x252b3c);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.35;
    this.grid.position.y = 0.001;
    this.scene.add(this.floor, this.ring, this.grid);

    this.camera.position.set(0, 1.0, 3.3);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 0.85, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 9;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.controls.update();

    this.setQuality(o.quality ?? "high");
    this.setBackground(o.background ?? "studio");
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.stop();
  };
  private onContextRestored = () => {
    this.start();
  };

  // ---- avatars
  add(avatar: RobotAvatar) {
    this.avatars.add(avatar);
    this.scene.add(avatar.root);
    avatar.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        // glossy black faceplates: keep the strong highlight but avoid a grey wash from the whole environment map
        for (const x of mats) {
          const s = x as THREE.MeshStandardMaterial;
          if (s.name === "Mat_Visor" && s.metalness < 0.5) s.envMapIntensity = 0.07;
        }
        // emissive parts (eyes, mouth, brows, ring joints) take part in the selective bloom
        if (mats.some((x) => x.name === "Mat_Glow" || x.name === "Mat_Face")) o.layers.enable(1);
      }
    });
  }
  remove(avatar: RobotAvatar) {
    this.avatars.delete(avatar);
    avatar.root.removeFromParent();
  }

  // ---- quality / appearance
  setQuality(q: QualityLevel) {
    this.quality = q;
    const c = QUALITY[q];
    const pr = Math.min(window.devicePixelRatio || 1, c.pixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.shadowMap.enabled = c.shadows;
    this.key.castShadow = c.shadows;
    this.key.shadow.mapSize.set(c.shadowMap, c.shadowMap);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
    this.renderer.toneMapping = c.toneMapping;
    this.renderer.toneMappingExposure = this.light.exposure;
    this.scene.environmentIntensity = c.envIntensity;
    this.grid.visible = q !== "low" && this.light.grid;
    this.setBloom(c.bloom);
    this.floor.receiveShadow = c.shadows;
    // materials need recompiling when shadows toggle
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
    });
    this.resize();
  }
  /**
   * Selective bloom: only meshes on the bloom layer (emissive eyes/mouth/ring joints) glow. Technique from the three.js
   * "selective bloom" example: render everything else black into a bloom buffer, blur it, add it to the normal frame.
   */
  setBloom(on: boolean) {
    this.bloom = on;
    if (on && !this.bloomComposer) {
      try {
        this.createBloom();
      } catch (e) {
        console.warn("bloom unavailable, rendering without glow", e);
        this.bloom = false;
        this.bloomComposer = this.finalComposer = null;
      }
    }
    if (!on && this.bloomComposer) {
      this.bloomComposer.dispose();
      this.finalComposer?.dispose();
      this.bloomPass?.dispose();
      this.bloomComposer = this.finalComposer = null;
      this.bloomPass = null;
    }
  }
  private createBloom() {
    {
      const size = this.renderer.getSize(new THREE.Vector2());
      const mk = () => new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      this.bloomComposer = new EffectComposer(this.renderer, mk());
      this.bloomComposer.renderToScreen = false;
      this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.16, 0.25, 0);
      this.bloomComposer.addPass(this.bloomPass);
      const mix = new ShaderPass(
        new THREE.ShaderMaterial({
          uniforms: { baseTexture: { value: null }, bloomTexture: { value: this.bloomComposer.renderTarget2.texture } },
          vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
          fragmentShader: "uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv; void main(){ gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv); }",
        }),
        "baseTexture",
      );
      mix.needsSwap = true;
      this.finalComposer = new EffectComposer(this.renderer, mk());
      this.finalComposer.addPass(new RenderPass(this.scene, this.camera));
      this.finalComposer.addPass(mix);
      this.finalComposer.addPass(new OutputPass());
      for (const c of [this.bloomComposer, this.finalComposer]) {
        c.setPixelRatio(this.renderer.getPixelRatio());
        c.setSize(size.x, size.y);
      }
    }
  }
  private draw() {
    if (!(this.bloom && this.bloomComposer && this.finalComposer)) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // 1. bloom buffer: non-emissive geometry black, no background
    const bg = this.scene.background;
    const fog = this.scene.fog;
    this.scene.background = null;
    this.scene.fog = null;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m.isMesh || (o as THREE.Line).isLine) && !this.bloomLayer.test(o.layers)) {
        this.stash.set(o, m.material);
        m.material = this.darkMat;
      }
    });
    this.bloomComposer.render();
    for (const [o, mat] of this.stash) (o as THREE.Mesh).material = mat;
    this.stash.clear();
    this.scene.background = bg;
    this.scene.fog = fog;
    // 2. final frame = normal render + bloom
    this.finalComposer.render();
  }

  setBackground(b: BackgroundPreset) {
    this.background = b;
    const p = BACKGROUNDS[b];
    this.scene.background = p.color ? new THREE.Color(p.color) : null;
    this.scene.fog = p.color ? new THREE.Fog(p.color, 7, 15) : null;
    (this.floor.material as THREE.MeshStandardMaterial).color.set(p.floor);
    this.renderer.setClearColor(0x000000, p.color ? 1 : 0);
  }
  /** key light intensity and azimuth (degrees around the robot, 0 = from the front) */
  setKeyLight(intensity: number, angleDeg?: number) {
    this.light.intensity = intensity;
    this.key.intensity = intensity;
    if (angleDeg !== undefined) {
      this.light.angleDeg = angleDeg;
      const a = (angleDeg * Math.PI) / 180;
      this.key.position.set(Math.sin(a) * 4.5, 4, Math.cos(a) * 4.5);
    }
  }
  setExposure(v: number) {
    this.light.exposure = v;
    this.renderer.toneMappingExposure = v;
  }
  showGrid(on: boolean) {
    this.light.grid = on;
    this.grid.visible = on;
    this.ring.visible = on;
  }

  // ---- camera
  setCameraPreset(p: CameraPreset, animate = true, robot?: RobotAvatar) {
    const base = robot ? robot.root.position.clone() : new THREE.Vector3();
    const yaw = robot ? robot.root.rotation.y : 0;
    // presets were tuned for the 1.57 m premium robot (head pivot 1.12 m, eye spacing 0.155 m); adapt to the loaded model
    const eyeSpacing = robot ? robot.joints.restWorldPos("eye_L").x * 2 : 0.155;
    // overall size from the model's real height (bind-pose bounds), so big-headed characters are framed correctly
    let height = 1.57;
    if (robot) {
      // world-space bounds of the skinned meshes relative to the robot's feet (geometry bounds may be quantized)
      robot.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(robot.root);
      height = Math.max(0.3, box.max.y - robot.root.position.y);
    }
    const k = height / 1.57;
    const kf = eyeSpacing / 0.155; // head size
    const eyeY = robot ? robot.joints.restWorldPos("eye_L").y : 1.3;
    const yaw3 = new THREE.Vector3(0, 1, 0);
    const dir = (x: number, y: number, z: number, s = k) => new THREE.Vector3(x * s, y * s, z * s).applyAxisAngle(yaw3, yaw);
    const presets: Record<CameraPreset, { pos: THREE.Vector3; tgt: THREE.Vector3 }> = {
      full: { pos: dir(0, 1.05, 3.6), tgt: dir(0, 0.82, 0) },
      upper: { pos: dir(0, 1.25, 1.8), tgt: dir(0, 1.0, 0) },
      face: { pos: dir(0, eyeY + 0.04, 0.95, Math.sqrt(kf)).setY(eyeY + 0.04), tgt: new THREE.Vector3(0, eyeY, 0).applyAxisAngle(yaw3, yaw) },
      side: { pos: dir(3.4, 1.0, 0.4), tgt: dir(0, 0.82, 0) },
      back: { pos: dir(0, 1.05, -3.6), tgt: dir(0, 0.82, 0) },
    };
    const { pos, tgt } = presets[p];
    pos.add(base);
    tgt.add(base);
    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      this.controls.update();
      return;
    }
    this.camTween = { from: this.camera.position.clone(), to: pos, fromT: this.controls.target.clone(), toT: tgt, t: 0, dur: 0.7 };
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    for (const c of [this.bloomComposer, this.finalComposer]) {
      c?.setPixelRatio(this.renderer.getPixelRatio());
      c?.setSize(w, h);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- loop
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Advance one frame (also callable manually, e.g. from tests or a custom loop). */
  frame(dt: number) {
    const t0 = performance.now();
    for (const a of this.avatars) a.update(dt);
    for (const f of this.onFrame) f(dt);
    if (this.camTween) {
      const tw = this.camTween;
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      const e = k * k * (3 - 2 * k);
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      if (k >= 1) this.camTween = null;
    }
    if (this.followTarget) {
      const f = this.followTarget();
      this.controls.target.lerp(f, 1 - Math.exp(-dt * 4));
    }
    this.controls.update();
    const first = [...this.avatars][0];
    if (first) {
      this.ring.position.x = first.root.position.x;
      this.ring.position.z = first.root.position.z;
      this.key.target.position.copy(first.root.position);
      this.key.target.updateMatrixWorld();
    }
    this.renderer.info.reset();
    this.draw();
    const ms = performance.now() - t0;
    this.frames++;
    this.fpsAcc += dt;
    this.frameMsAcc += ms;
    if (this.fpsAcc >= 0.5) {
      const info = this.renderer.info;
      this._stats = {
        fps: Math.round(this.frames / this.fpsAcc), frameMs: +(this.frameMsAcc / this.frames).toFixed(2),
        calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries,
        textures: info.memory.textures, pixelRatio: this.renderer.getPixelRatio(),
      };
      this.frames = 0;
      this.fpsAcc = 0;
      this.frameMsAcc = 0;
    }
  }
  get stats(): ViewerStats {
    return this._stats;
  }

  screenshot(type = "image/png"): string {
    this.draw();
    return this.canvas.toDataURL(type);
  }

  dispose() {
    this.stop();
    this.ro?.disconnect();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.controls.dispose();
    for (const a of this.avatars) a.dispose();
    this.avatars.clear();
    this.setBloom(false);
    this.envTex.dispose();
    this.pmrem.dispose();
    this.floor.geometry.dispose();
    (this.floor.material as THREE.Material).dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (this.canvas.parentElement === this.container) this.container.removeChild(this.canvas);
  }
}
