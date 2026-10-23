import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * Procedural reception lobby (no external assets): polished stone floor, walnut slat feature wall with a backlit
 * sign, reception desk, floor-to-ceiling glass wall with daylight, plants, lounge bench and ceiling downlights.
 * Units are metres; the robot stands at the origin facing +Z, the desk is behind it.
 */
/** a university / company identity for the room: backlit sign, desk logo plate and brand-coloured LED/trim */
export interface LobbyBrand {
  logo: string;
  nameAr: string;
  nameEn: string;
  /** main brand colour (LED lines, sign underline) and accent (desk inlay, sign rule) */
  primary: string;
  accent: string;
}

export interface Lobby {
  group: THREE.Group;
  /** brand the sign, desk and trims (null = neutral "RECEPTION" sign) */
  setBrand(brand: LobbyBrand | null): Promise<void>;
  /** room half sizes, used to keep the orbit camera inside */
  bounds: { x: number; zBack: number; zFront: number; height: number };
  dispose(): void;
}

const W = 8; // half width (x)
const Z_BACK = -5.5;
const Z_FRONT = 7.5;
const H = 3.4;

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true, repeat?: [number, number]) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** deterministic pseudo-random (textures look the same on every load) */
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

// ------------------------------------------------------------------ textures
/** large-format light stone tiles (2 x 2 tiles per texture, 1.2 m each) with soft veining and thin grout */
function stoneTextures() {
  const N = 1024;
  const r = rng(7);
  const veins = (g: CanvasRenderingContext2D, alpha: number, color: string) => {
    for (let k = 0; k < 26; k++) {
      g.strokeStyle = color;
      g.globalAlpha = alpha * (0.3 + r() * 0.7);
      g.lineWidth = 0.6 + r() * 2.2;
      g.beginPath();
      let x = r() * N, y = r() * N;
      g.moveTo(x, y);
      for (let s = 0; s < 14; s++) {
        x += (r() - 0.35) * 90;
        y += (r() - 0.5) * 70;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  };
  const map = canvasTex(N, N, (g) => {
    g.fillStyle = "#d8d3cb";
    g.fillRect(0, 0, N, N);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        const v = 210 + Math.floor(r() * 14);
        g.fillStyle = `rgb(${v},${v - 4},${v - 11})`;
        g.fillRect(i * N / 2, j * N / 2, N / 2, N / 2);
      }
    // cloudy variation
    for (let k = 0; k < 220; k++) {
      const x = r() * N, y = r() * N, rad = 20 + r() * 120;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      const d = r() < 0.5 ? "255,252,246" : "170,160,148";
      gr.addColorStop(0, `rgba(${d},0.07)`);
      gr.addColorStop(1, `rgba(${d},0)`);
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    veins(g, 0.22, "#9c948a");
    veins(g, 0.35, "#f6f2ec");
    g.fillStyle = "#b7b0a6"; // grout
    g.fillRect(0, 0, N, 3);
    g.fillRect(0, 0, 3, N);
    g.fillRect(0, N / 2 - 1, N, 3);
    g.fillRect(N / 2 - 1, 0, 3, N);
  }, true, [W * 2 / 2.4, (Z_FRONT - Z_BACK) / 2.4]);
  const rough = canvasTex(256, 256, (g) => {
    g.fillStyle = "#3a3a3a"; // polished
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = "#c8c8c8"; // grout is rough
    g.fillRect(0, 0, 256, 2);
    g.fillRect(0, 0, 2, 256);
    g.fillRect(0, 127, 256, 2);
    g.fillRect(127, 0, 2, 256);
  }, false, [W * 2 / 2.4, (Z_FRONT - Z_BACK) / 2.4]);
  return { map, rough };
}

/** walnut vertical slats with dark grooves */
function walnutTexture(repeatX: number) {
  const r = rng(11);
  return canvasTex(512, 1024, (g) => {
    const slat = 64;
    for (let x = 0; x < 512; x += slat) {
      const base = 92 + Math.floor(r() * 22);
      g.fillStyle = `rgb(${base},${Math.floor(base * 0.62)},${Math.floor(base * 0.4)})`;
      g.fillRect(x, 0, slat, 1024);
      for (let k = 0; k < 40; k++) { // grain
        const gx = x + 4 + r() * (slat - 8);
        g.strokeStyle = r() < 0.5 ? "rgba(40,22,10,0.25)" : "rgba(170,120,80,0.18)";
        g.lineWidth = 0.6 + r() * 1.4;
        g.beginPath();
        g.moveTo(gx, 0);
        for (let y = 0; y <= 1024; y += 64) g.lineTo(gx + Math.sin(y * 0.01 + k) * 2.5 * r(), y);
        g.stroke();
      }
      const sh = g.createLinearGradient(x, 0, x + slat, 0); // rounded slat shading
      sh.addColorStop(0, "rgba(0,0,0,0.35)");
      sh.addColorStop(0.15, "rgba(0,0,0,0)");
      sh.addColorStop(0.85, "rgba(255,255,255,0.04)");
      sh.addColorStop(1, "rgba(0,0,0,0.5)");
      g.fillStyle = sh;
      g.fillRect(x, 0, slat, 1024);
      g.fillStyle = "#140b06"; // groove
      g.fillRect(x + slat - 7, 0, 7, 1024);
    }
  }, true, [repeatX, 1]);
}

/** bright daylight seen through the glass: sky gradient, soft distant buildings, trees */
function outsideTexture() {
  const r = rng(5);
  // painted at 1/4 size and scaled up once: a cheap, soft focus (canvas blur filters are very slow in software GL)
  const small = document.createElement("canvas");
  small.width = 512;
  small.height = 128;
  const g = small.getContext("2d")!;
  g.scale(0.25, 0.25);
  const sky = g.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, "#9fc4ea");
  sky.addColorStop(0.55, "#dcebf7");
  sky.addColorStop(1, "#f4f1ea");
  g.fillStyle = sky;
  g.fillRect(0, 0, 2048, 512);
  for (let i = 0; i < 26; i++) { // buildings
    const w = 60 + r() * 160, h = 90 + r() * 260, x = r() * 2048;
    const c = 196 + Math.floor(r() * 40);
    g.fillStyle = `rgb(${c},${c + 4},${c + 10})`;
    g.fillRect(x, 400 - h, w, h + 120);
    g.fillStyle = "rgba(120,150,180,0.25)";
    for (let y = 400 - h + 12; y < 400; y += 22) for (let wx = x + 8; wx < x + w - 10; wx += 18) g.fillRect(wx, y, 10, 12);
  }
  for (let i = 0; i < 70; i++) { // trees
    const x = r() * 2048, y = 410 + r() * 30, rad = 25 + r() * 45;
    g.fillStyle = `rgba(${70 + r() * 40},${110 + r() * 40},${60 + r() * 30},0.9)`;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#cfd2cf";
  g.fillRect(0, 440, 2048, 72);
  return canvasTex(1024, 256, (c) => {
    c.imageSmoothingQuality = "high";
    c.drawImage(small, 0, 0, 1024, 256);
  });
}

function signTexture() {
  return canvasTex(1024, 256, (g) => {
    g.clearRect(0, 0, 1024, 256);
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "600 92px 'Segoe UI', Tahoma, Arial, sans-serif";
    g.fillText("الاستقبال", 512, 92);
    g.font = "500 54px 'Segoe UI', Arial, sans-serif";
    g.fillText("R E C E P T I O N", 512, 194);
  });
}

// ------------------------------------------------------------------ build
export function buildLobby(): Lobby {
  const group = new THREE.Group();
  group.name = "Lobby";
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadow = false) => {
    const m = new THREE.Mesh(keep(geo), mat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    m.castShadow = shadow;
    group.add(m);
    return m;
  };

  // materials
  const stone = stoneTextures();
  keep(stone.map);
  keep(stone.rough);
  const floorMat = keep(new THREE.MeshPhysicalMaterial({ map: stone.map, roughnessMap: stone.rough, roughness: 1, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.12 }));
  const plaster = keep(new THREE.MeshStandardMaterial({ color: 0xf1eee8, roughness: 0.92 }));
  const ceilingMat = keep(new THREE.MeshStandardMaterial({ color: 0xf6f5f2, roughness: 0.95 }));
  const walnutTex = keep(walnutTexture(7));
  const walnut = keep(new THREE.MeshStandardMaterial({ map: walnutTex, roughness: 0.55, metalness: 0 }));
  const deskWhite = keep(new THREE.MeshPhysicalMaterial({ color: 0xf4f3f0, roughness: 0.32, clearcoat: 0.4, clearcoatRoughness: 0.2 }));
  const deskTopTex = keep(walnutTexture(3));
  deskTopTex.rotation = Math.PI / 2;
  const deskTop = keep(new THREE.MeshStandardMaterial({ map: deskTopTex, roughness: 0.4 }));
  const darkMetal = keep(new THREE.MeshStandardMaterial({ color: 0x1d1f23, roughness: 0.4, metalness: 0.8 }));
  const brass = keep(new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.3, metalness: 1 }));
  const inlay = keep(new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.3, metalness: 1 }));
  const deskLed = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff1dc, emissiveIntensity: 2.2 }));
  const ledWarm = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff1dc, emissiveIntensity: 2.2 }));
  const downlight = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff6e8, emissiveIntensity: 3 }));
  const glass = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.1, depthWrite: false }));
  const outside = keep(outsideTexture());
  const outsideMat = keep(new THREE.MeshBasicMaterial({ map: outside, toneMapped: false, color: 0xd8d8d8 }));
  const potMat = keep(new THREE.MeshStandardMaterial({ color: 0x2e2c2a, roughness: 0.7 }));
  const soil = keep(new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 1 }));
  const leafMat = keep(new THREE.MeshStandardMaterial({ color: 0x2f6b34, roughness: 0.55, side: THREE.DoubleSide }));
  const fabric = keep(new THREE.MeshStandardMaterial({ color: 0x8b8378, roughness: 0.95 }));
  const screenMat = keep(new THREE.MeshStandardMaterial({ color: 0x050608, roughness: 0.15, emissive: 0x16283c, emissiveIntensity: 0.6 }));

  // ---- shell of the room
  const depth = Z_FRONT - Z_BACK;
  const zMid = (Z_FRONT + Z_BACK) / 2;
  const floor = mesh(new THREE.PlaneGeometry(W * 2, depth), floorMat, 0, 0, zMid);
  floor.rotation.x = -Math.PI / 2;
  const ceil = mesh(new THREE.PlaneGeometry(W * 2, depth), ceilingMat, 0, H, zMid);
  ceil.rotation.x = Math.PI / 2;
  // back wall: plaster with a walnut slat feature wall in the middle
  mesh(new THREE.PlaneGeometry(W * 2, H), plaster, 0, H / 2, Z_BACK);
  const feature = mesh(new THREE.BoxGeometry(7, H, 0.08), walnut, 0, H / 2, Z_BACK + 0.04);
  feature.receiveShadow = true;
  // backlit sign floating on the feature wall
  const signTex = keep(signTexture());
  const signMat = keep(new THREE.MeshStandardMaterial({ map: signTex, transparent: true, color: 0x000000, emissive: 0xfff3df, emissiveMap: signTex, emissiveIntensity: 1.6 }));
  const SIGN_X = 1.85, SIGN_Y = 2.35; // beside the robot's head, not behind it
  const sign = mesh(new THREE.PlaneGeometry(2.2, 0.55), signMat, SIGN_X, SIGN_Y, Z_BACK + 0.1);
  sign.receiveShadow = false;
  // brand logo plate on the front of the reception desk (hidden until a brand is set)
  const deskLogoMat = keep(new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const deskLogo = mesh(new THREE.PlaneGeometry(1.5, 0.375), deskLogoMat, -0.95, 0.58, -4.0 + 0.377 + 0.002);
  deskLogo.visible = false;
  deskLogo.receiveShadow = false;
  // warm wall-washer slot above the feature wall
  mesh(new THREE.BoxGeometry(7, 0.03, 0.06), ledWarm, 0, H - 0.04, Z_BACK + 0.2);
  // front wall (behind the camera) and right wall: plaster
  const front = mesh(new THREE.PlaneGeometry(W * 2, H), plaster, 0, H / 2, Z_FRONT);
  front.rotation.y = Math.PI;
  const right = mesh(new THREE.PlaneGeometry(depth, H), plaster, W, H / 2, zMid);
  right.rotation.y = -Math.PI / 2;
  // skirting
  mesh(new THREE.BoxGeometry(W * 2, 0.08, 0.02), darkMetal, 0, 0.04, Z_BACK + 0.09);
  // left: floor-to-ceiling glass wall with mullions and daylight outside
  const out = mesh(new THREE.PlaneGeometry(depth + 8, H + 2.5), outsideMat, -W - 2.5, H / 2 + 0.6, zMid);
  out.rotation.y = Math.PI / 2;
  out.receiveShadow = false;
  const pane = mesh(new THREE.PlaneGeometry(depth, H), glass, -W, H / 2, zMid);
  pane.rotation.y = Math.PI / 2;
  for (let z = Z_BACK; z <= Z_FRONT + 0.01; z += 1.6) mesh(new THREE.BoxGeometry(0.08, H, 0.06), darkMetal, -W + 0.02, H / 2, z);
  mesh(new THREE.BoxGeometry(0.1, 0.1, depth), darkMetal, -W + 0.02, 0.05, zMid);
  mesh(new THREE.BoxGeometry(0.1, 0.1, depth), darkMetal, -W + 0.02, H - 0.05, zMid);

  // ---- ceiling: recessed round downlights + a linear light over the desk
  const dlGeo = keep(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 24));
  const rimGeo = keep(new THREE.TorusGeometry(0.085, 0.012, 8, 32));
  for (let x = -6; x <= 6.01; x += 2) {
    for (let z = Z_BACK + 1.5; z <= Z_FRONT - 1; z += 2.2) {
      const d = new THREE.Mesh(dlGeo, downlight);
      d.position.set(x, H - 0.005, z);
      group.add(d);
      const ring = new THREE.Mesh(rimGeo, plaster);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(x, H - 0.008, z);
      group.add(ring);
    }
  }
  mesh(new THREE.BoxGeometry(3.6, 0.03, 0.12), ledWarm, 0, H - 0.01, -3.95);

  // ---- reception desk (behind the robot): white solid-surface body, walnut top, brass trim, floating LED base
  const deskZ = -4.0;
  const desk = mesh(new RoundedBoxGeometry(3.4, 1.0, 0.75, 6, 0.06), deskWhite, 0, 0.56, deskZ, true);
  desk.castShadow = true;
  mesh(new RoundedBoxGeometry(3.55, 0.05, 0.85, 4, 0.02), deskTop, 0, 1.085, deskZ, true);
  mesh(new THREE.BoxGeometry(3.3, 0.06, 0.65), darkMetal, 0, 0.03, deskZ); // recessed plinth
  mesh(new THREE.BoxGeometry(3.25, 0.012, 0.012), deskLed, 0, 0.07, deskZ + 0.33); // floating LED line
  mesh(new THREE.BoxGeometry(3.42, 0.012, 0.012), inlay, 0, 0.82, deskZ + 0.376); // brass inlay
  // monitor + small items on the desk
  mesh(new THREE.BoxGeometry(0.62, 0.38, 0.025), screenMat, -0.7, 1.36, deskZ - 0.12, true).rotation.y = 0.12;
  mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 12), darkMetal, -0.7, 1.17, deskZ - 0.14);
  mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.012, 24), darkMetal, -0.7, 1.115, deskZ - 0.14);
  mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.2, 20), brass, 1.1, 1.2, deskZ - 0.05, true); // vase
  // ---- plants
  const leafGeo = keep(new THREE.SphereGeometry(1, 10, 6));
  const plant = (x: number, z: number, h: number, seed: number) => {
    const r = rng(seed);
    const pot = mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.55, 32), potMat, x, 0.275, z, true);
    pot.castShadow = true;
    mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.02, 24), soil, x, 0.54, z);
    const n = 120;
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, t = Math.pow(r(), 0.7);
      const tilt = 0.15 + t * 0.9;
      const len = 0.15 + r() * 0.13;
      p.set(x + Math.cos(a) * t * 0.35, 0.56 + (h - 0.6) * (0.3 + 0.7 * (1 - t * 0.6)) * (0.5 + r() * 0.5), z + Math.sin(a) * t * 0.35);
      q.setFromEuler(new THREE.Euler(tilt * Math.sin(a), a, -tilt * Math.cos(a), "YXZ"));
      s.set(len * 0.26, 0.008, len);
      leaves.setMatrixAt(i, m.compose(p, q, s));
      leaves.setColorAt(i, new THREE.Color().setHSL(0.31 + r() * 0.04, 0.45, 0.2 + r() * 0.1));
    }
    leaves.castShadow = true;
    leaves.receiveShadow = true;
    group.add(leaves);
  };
  plant(-2.35, deskZ + 0.1, 1.6, 3);
  plant(2.35, deskZ + 0.1, 1.45, 9);
  plant(-W + 0.6, Z_BACK + 0.7, 1.9, 21);
  plant(W - 0.6, 2.5, 1.7, 33);
  // ---- lounge bench on the right
  mesh(new RoundedBoxGeometry(0.6, 0.42, 2.2, 4, 0.08), fabric, W - 0.55, 0.25, -0.6, true);
  mesh(new THREE.BoxGeometry(0.5, 0.04, 2.0), darkMetal, W - 0.55, 0.02, -0.6);
  // framed art on the right wall
  const art = mesh(new THREE.PlaneGeometry(1.6, 1.0), keep(new THREE.MeshStandardMaterial({ map: keep(canvasTex(512, 320, (g) => {
    const gr = g.createLinearGradient(0, 0, 512, 320);
    gr.addColorStop(0, "#1f4e79");
    gr.addColorStop(0.5, "#8fb8d8");
    gr.addColorStop(1, "#e9dcc6");
    g.fillStyle = gr;
    g.fillRect(0, 0, 512, 320);
    g.strokeStyle = "rgba(255,255,255,0.5)";
    g.lineWidth = 6;
    g.beginPath();
    g.arc(330, 170, 90, 0, Math.PI * 2);
    g.stroke();
  })), roughness: 0.6 })), W - 0.02, 1.75, -0.6);
  art.rotation.y = -Math.PI / 2;
  mesh(new THREE.BoxGeometry(0.03, 1.08, 1.68), darkMetal, W - 0.01, 1.75, -0.6);

  // ---- lights that belong to the room (the viewer keeps its key/fill/rim lights for the robot)
  const hemi = new THREE.HemisphereLight(0xfff8ee, 0x8a7f70, 0.55);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2e0, 0.9); // daylight through the glass
  sun.position.set(-W - 3, 3.5, 1);
  group.add(sun);
  const deskSpot = new THREE.SpotLight(0xffe7c8, 9, 6, Math.PI / 5, 0.6, 1.5);
  deskSpot.position.set(0, H - 0.1, deskZ + 0.4);
  deskSpot.target.position.set(0, 0.8, deskZ);
  group.add(deskSpot, deskSpot.target);
  const wallWash = new THREE.SpotLight(0xffd9a8, 14, 5, Math.PI / 3.2, 0.8, 1.6);
  wallWash.position.set(0, H - 0.2, Z_BACK + 1.4);
  wallWash.target.position.set(0, 1.4, Z_BACK);
  group.add(wallWash, wallWash.target);

  const loader = new THREE.TextureLoader();
  let brandToken = 0;
  let brandTex: THREE.Texture[] = []; // textures made for the current brand, released when it changes
  const dropBrandTex = () => {
    brandTex.forEach((x) => x.dispose());
    brandTex = [];
  };
  async function setBrand(brand: LobbyBrand | null) {
    const token = ++brandToken;
    if (!brand) {
      dropBrandTex();
      const neutral = keep(signTexture());
      signMat.map = signMat.emissiveMap = neutral;
      sign.geometry.dispose();
      sign.geometry = new THREE.PlaneGeometry(2.2, 0.55);
      signMat.needsUpdate = true;
      deskLogo.visible = false;
      deskLed.emissive.set(0xfff1dc);
      inlay.color.set(0xb08d57);
      return;
    }
    const logo = (await loader.loadAsync(brand.logo)).image as HTMLImageElement;
    if (token !== brandToken) return; // a newer setBrand call won
    // sign: logo + Arabic and Latin names + a two-colour rule, white on the walnut wall
    const sTex = (canvasTex(2048, 640, (g) => {
      g.clearRect(0, 0, 2048, 640);
      const lh = 560, lw = lh * (logo.width / logo.height);
      g.drawImage(logo, 40, 40, lw, lh);
      const x0 = 40 + lw + 70, cx = x0 + (2048 - x0 - 40) / 2;
      g.fillStyle = "#ffffff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = "700 210px 'Segoe UI', Tahoma, Arial, sans-serif";
      g.fillText(brand.nameAr, cx, 190);
      g.font = "600 92px 'Segoe UI', Arial, sans-serif";
      g.fillText(brand.nameEn.toUpperCase().split("").join(" "), cx, 390);
      g.fillStyle = brand.primary;
      g.fillRect(x0 + 20, 480, (2048 - x0 - 80) * 0.62, 12);
      g.fillStyle = brand.accent;
      g.fillRect(x0 + 20 + (2048 - x0 - 80) * 0.62, 480, (2048 - x0 - 80) * 0.38, 12);
    }));
    signMat.map = signMat.emissiveMap = sTex;
    signMat.emissive.set(0xffffff);
    sign.geometry.dispose();
    sign.geometry = new THREE.PlaneGeometry(2.5, 2.5 * 640 / 2048);
    signMat.needsUpdate = true;
    // desk plate: logo on the white front panel with the Latin name underneath
    const dTex = (canvasTex(1536, 384, (g) => {
      g.clearRect(0, 0, 1536, 384);
      const lh = 340, lw = lh * (logo.width / logo.height);
      g.drawImage(logo, 20, 22, lw, lh);
      g.fillStyle = "#26323f";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.font = "700 120px 'Segoe UI', Tahoma, Arial, sans-serif";
      g.fillText(brand.nameAr, lw + 70, 120);
      g.font = "600 64px 'Segoe UI', Arial, sans-serif";
      g.fillText(brand.nameEn.toUpperCase(), lw + 70, 250);
      g.fillStyle = brand.primary;
      g.fillRect(lw + 70, 310, 360, 10);
      g.fillStyle = brand.accent;
      g.fillRect(lw + 430, 310, 190, 10);
    }));
    dropBrandTex();
    brandTex = [sTex, dTex];
    deskLogoMat.map = dTex;
    deskLogoMat.needsUpdate = true;
    deskLogo.visible = true;
    deskLed.emissive.set(brand.primary);
    inlay.color.set(brand.accent);
    inlay.metalness = 0.3;
  }

  return {
    group,
    setBrand,
    bounds: { x: W, zBack: Z_BACK, zFront: Z_FRONT, height: H },
    dispose() {
      dropBrandTex();
      disposables.forEach((d) => d.dispose());
      group.removeFromParent();
    },
  };
}
