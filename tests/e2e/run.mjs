// End-to-end tests in a real Chromium (WebGL via SwiftShader when no GPU).
//   npm run test:e2e         builds, serves dist with `vite preview`, drives the Control Studio
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "tests/e2e/out");
const shotDir = path.join(root, "docs/screenshots");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(shotDir, { recursive: true });
const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"];

if (!process.env.SKIP_BUILD) {
  const b = spawnSync("npx", ["vite", "build"], { cwd: root, stdio: "inherit" });
  if (b.status !== 0) process.exit(1);
}
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore" });
const kill = () => server.kill("SIGTERM");
process.on("exit", kill);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(URL)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

const results = [];
let failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, info });
    console.log(`  ✓ ${name}${info ? "  " + JSON.stringify(info) : ""}`);
  } catch (e) {
    failed++;
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message ?? e) });
    console.log(`  ✗ ${name}\n      ${String(e.message ?? e).split("\n")[0]}`);
  }
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };

const browser = await chromium.launch({ executablePath: CHROME, args: GL_ARGS });
const consoleErrors = [];
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  await page.goto(URL);
  await page.waitForSelector('[data-testid="viewport"] canvas', { timeout: 60000 });
  await page.waitForFunction(() => window.robot && window.studio, null, { timeout: 60000 });
  // the software rasteriser is slow: run the functional checks at "medium" (no bloom); bloom is verified separately
  await page.evaluate(() => window.studio.setQuality("medium"));
  // the lobby (default) is heavier than the plain studio backdrop: functional checks use the light one, the lobby has its own test
  await page.evaluate(() => window.studio.setBackground("studio"));
  return { ctx, page };
}
const status = (page) => page.evaluate(() => window.robot.getStatus());
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
// Software WebGL renders slowly, so wall-clock != robot time. Wait in *robot seconds* (the engine clamps dt to 0.1 per frame).
const robotWait = async (page, sec) => {
  const t0 = await page.evaluate(() => window.robot.time);
  await page.waitForFunction(([a, s]) => window.robot.time >= a + s, [t0, sec], { timeout: 90000, polling: 50 });
};

console.log("\nControl Studio E2E");
const { ctx, page } = await open();

await check("studio boots: WebGL canvas, rigged robot with 40 bones and 5 face meshes, no console errors", async () => {
  const info = await page.evaluate(() => {
    const r = window.robot;
    const bones = new Set();
    r.model.traverse((o) => o.isBone && bones.add(o.name));
    const c = document.querySelector("canvas");
    return { bones: bones.size, meshes: r.parts.meshes.size, skinned: r.parts.skinned.length, w: c.clientWidth, h: c.clientHeight, gl: !!c.getContext("webgl2") };
  });
  ok(info.bones === 40 && info.skinned === info.meshes, "rig incomplete " + JSON.stringify(info));
  ok(info.w > 600 && info.h > 600, "canvas too small");
  ok(consoleErrors.length === 0, "console errors: " + consoleErrors.join(" | "));
  return info;
});

await check("the 3D view really renders the robot (non-background pixels, from several camera angles)", async () => {
  const shots = {};
  for (const cam of ["full", "face", "side", "back"]) {
    await page.click(`[data-testid="cam-${cam}"]`);
    await page.waitForTimeout(1200);
    shots[cam] = await page.evaluate(() => {
      const v = window.viewer;
      const url = v.screenshot();
      return new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          const g = c.getContext("2d"); g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          // count bright pixels (the pearl-white shell) that differ from the dark background
          let bright = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] > 150 && d[i + 2] > 150) bright++;
          res(bright / (d.length / 4));
        };
        img.src = url;
      });
    });
    await page.screenshot({ path: path.join(shotDir, `studio-cam-${cam}.png`) });
    ok(shots[cam] > 0.01, `camera ${cam}: robot not visible (${shots[cam]})`);
  }
  await page.click('[data-testid="cam-full"]');
  return shots;
});

await check("orbit controls rotate the camera 360° and zoom (mouse drag + wheel)", async () => {
  await page.click('[data-testid="cam-full"]');
  await page.waitForTimeout(1000);
  const before = await page.evaluate(() => window.viewer.camera.position.toArray());
  const box = await page.locator('[data-testid="viewport"] canvas').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 600);
  await page.mouse.down();
  await page.mouse.move(box.x + 700, box.y + 600, { steps: 12 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.viewer.camera.position.toArray());
  ok(Math.hypot(after[0] - before[0], after[2] - before[2]) > 0.8, "drag did not orbit");
  const d0 = await page.evaluate(() => window.viewer.camera.position.distanceTo(window.viewer.controls.target));
  await page.mouse.move(box.x + 500, box.y + 400);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(600);
  const d1 = await page.evaluate(() => window.viewer.camera.position.distanceTo(window.viewer.controls.target));
  ok(d1 < d0 - 0.2, `zoom did not change distance (${d0} -> ${d1})`);
  await page.click('[data-testid="cam-full"]');
  return { orbitDelta: +Math.hypot(after[0] - before[0], after[2] - before[2]).toFixed(2), zoom: [+d0.toFixed(2), +d1.toFixed(2)] };
});

await check("animation buttons trigger the real animation system (greeting raises the hand; priorities respected)", async () => {
  await page.click('[data-testid="anim-greeting"]');
  await waitFor(page, () => window.robot.animation.ownerOf("armR")?.name === "greeting");
  await robotWait(page, 1.2);
  const y = await page.evaluate(() => {
    const r = window.robot; r.root.updateMatrixWorld(true);
    return r.root.worldToLocal(r.joints.bone("hand_R").getWorldPosition(new r.root.position.constructor())).y;
  });
  ok(y > 0.95, "hand not raised: y=" + y);
  await page.click('[data-testid="anim-pointing"]');
  await robotWait(page, 0.2);
  const s = await status(page);
  ok(s.animations.armR[0] === "pointing", "pointing should take armR");
  await page.click('[data-testid="anim-greeting"]');
  await robotWait(page, 0.2);
  ok((await status(page)).animations.armR[0] === "pointing", "greeting must be blocked by pointing");
  return { handY: +y.toFixed(2) };
});

await check("every animation chip plays without errors and returns to idle", async () => {
  await page.click('[data-testid="reset"]');
  const names = await page.evaluate(() => window.robot.listAnimations().filter((n) => !["talkR", "talkL", "idle", "walking", "turning"].includes(n)));
  for (const n of names) {
    await page.click(`[data-testid="anim-${n}"]`);
    await page.waitForTimeout(250);
  }
  await page.click('[data-testid="reset"]');
  await page.waitForTimeout(1500);
  const s = await status(page);
  ok(s.animations.armR[0] === "idle" && s.animations.head[0] === "idle", "did not return to idle: " + JSON.stringify(s.animations));
  ok(consoleErrors.length === 0, "console errors: " + consoleErrors.join(" | "));
  return { played: names.length };
});

await check("emotion + eye-expression chips drive real morph targets", async () => {
  await page.click('[data-testid="emo-happy"]');
  await waitFor(page, () => { const m = window.robot.parts.meshes.get("Mouth"); return m.morphTargetInfluences[m.morphTargetDictionary.mouthSmile] > 0.9; });
  await page.click('[data-testid="eye-angry"]');
  await waitFor(page, () => { const m = window.robot.parts.meshes.get("Eye_L"); return m.morphTargetInfluences[m.morphTargetDictionary.eyeAngry] > 0.9; }, null, 30000);
  const mouthStill = await page.evaluate(() => { const m = window.robot.parts.meshes.get("Mouth"); return m.morphTargetInfluences[m.morphTargetDictionary.mouthSmile]; });
  ok(mouthStill > 0.8, "eye expression must not change the mouth emotion: " + mouthStill);
  await page.click('[data-testid="eye-auto"]');
  await page.click('[data-testid="emo-neutral"]');
  return true;
});

await check("walk button moves the robot to the requested point and it ends idle", async () => {
  await page.click('[data-testid="reset"]');
  await page.click('[data-testid="walk-go"]'); // default x=1.5 z=2
  await waitFor(page, () => window.robot.locomotion.state === "walking", null, 5000);
  await page.screenshot({ path: path.join(shotDir, "studio-walking.png") });
  await waitFor(page, () => { const p = window.robot.root.position; return window.robot.locomotion.state === "idle" && Math.hypot(p.x - 1.5, p.z - 2) < 0.1; }, null, 60000);
  return await page.evaluate(() => ({ x: +window.robot.root.position.x.toFixed(2), z: +window.robot.root.position.z.toFixed(2) }));
});

await check("Joints tab: select a joint and drag its sliders -> the real bone rotates within its limits", async () => {
  await page.click('[data-testid="reset"]');
  await page.click('[data-testid="tab-Joints"]');
  await page.selectOption('[data-testid="joint-select"]', "upperarm_L");
  await page.waitForSelector('code:text-is("upperarm_L")'); // React has re-rendered the panel for the new joint
  const before = await page.evaluate(() => window.robot.joints.currentEuler("upperarm_L"));
  await page.locator('[data-testid="joint-x"]').fill("-70");
  await robotWait(page, 0.8);
  const after = await page.evaluate(() => window.robot.joints.currentEuler("upperarm_L"));
  ok(Math.abs(after.x + 70) < 2, `shoulder x expected -70 got ${after.x}`);
  ok(Math.abs(before.x - after.x) > 40, "no movement");
  const ov = await page.evaluate(() => window.robot.overrides.active());
  ok(ov.includes("upperarm_L"), "override missing");
  // the elbow limit (0..150) is enforced by the slider range itself and by the engine
  await page.selectOption('[data-testid="joint-select"]', "forearm_R");
  await page.waitForSelector('code:text-is("forearm_R")');
  const lim = await page.locator('[data-testid="joint-x"]').evaluate((el) => [el.min, el.max]);
  ok(lim[0] === "-150" && lim[1] === "5", "limits not applied: " + lim);
  await page.screenshot({ path: path.join(shotDir, "studio-joints.png") });
  await page.click('button:has-text("Release all")');
  return { shoulderX: +after.x.toFixed(1) };
});

await check("clicking the robot selects the nearest joint (part picking)", async () => {
  await page.click('[data-testid="reset"]');
  await page.click('[data-testid="cam-full"]');
  await page.waitForTimeout(1200);
  for (const [bone, expectBase] of [["head", /head|neck/], ["hand_L", /hand_L|forearm_L|finger/], ["shin_R", /shin_R|thigh_R|foot_R/]]) {
    const pt = await page.evaluate((b) => {
      const w = window.robot.joints.bone(b).getWorldPosition(new window.robot.root.position.constructor());
      w.project(window.viewer.camera);
      const rect = window.viewer.canvas.getBoundingClientRect();
      return { x: rect.left + ((w.x + 1) / 2) * rect.width, y: rect.top + ((1 - w.y) / 2) * rect.height };
    }, bone);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(300);
    const sel = await page.evaluate(() => window.studio.selectedBone);
    ok(sel && expectBase.test(sel), `clicking ${bone} selected ${sel}`);
  }
  return true;
});

await check("head / arm / mouth sliders call the Robot API (moveHead, moveArm, setMouthOpen)", async () => {
  await page.click('[data-testid="reset"]');
  await page.locator('[data-testid="head-yaw"]').fill("40");
  await page.locator('[data-testid="mouth-open"]').fill("0.8");
  await page.locator('[data-testid="arm-R-elbow"]').fill("90");
  await robotWait(page, 1.2);
  const r = await page.evaluate(() => {
    const rb = window.robot, h = rb.joints.currentEuler("head"), n = rb.joints.currentEuler("neck");
    const m = rb.parts.meshes.get("Mouth");
    return { yaw: h.y + n.y, mouth: m.morphTargetInfluences[m.morphTargetDictionary.mouthOpen], elbow: rb.joints.currentEuler("forearm_R").x };
  });
  ok(Math.abs(r.yaw - 40) < 2 && Math.abs(r.mouth - 0.8) < 0.05 && Math.abs(r.elbow + 90) < 2, JSON.stringify(r));
  return r;
});

await check("Joints tab: torso slider, wink and per-eye controls reach the real bones/morphs", async () => {
  await page.click('[data-testid="reset"]');
  await page.click('[data-testid="tab-Joints"]');
  await page.locator('[data-testid="torso-yaw"]').fill("30");
  await page.click('[data-testid="wink-left"]');
  const peaks = await page.evaluate(async () => {
    const r = window.robot; let pl = 0, pr = 0;
    const L = r.parts.meshes.get("Eye_L"), R = r.parts.meshes.get("Eye_R");
    const t0 = performance.now();
    window.viewer.stop();
    let last = t0;
    while (performance.now() - t0 < 1500) {
      await new Promise((res) => setTimeout(res, 8));
      const now = performance.now(); r.update((now - last) / 1000); last = now;
      pl = Math.max(pl, L.morphTargetInfluences[L.morphTargetDictionary.eyeBlink]);
      pr = Math.max(pr, R.morphTargetInfluences[R.morphTargetDictionary.eyeBlink]);
    }
    window.viewer.start();
    return { pl, pr, torsoYaw: r.joints.currentEuler("spine").y + r.joints.currentEuler("chest").y };
  });
  ok(peaks.pl > 0.9 && peaks.pr < 0.05, "wink should close only the left eye: " + JSON.stringify(peaks));
  ok(Math.abs(peaks.torsoYaw - 30) < 3, "torso slider did not turn the upper body: " + peaks.torsoYaw);
  return peaks;
});

await check("JSON command console executes commands; invalid input reports an error", async () => {
  await page.click('[data-testid="tab-Developer"]');
  await page.locator('[data-testid="json-input"]').fill('{"cmd":"setEmotion","emotion":"surprised","id":42}');
  await page.click('[data-testid="json-send"]');
  await waitFor(page, () => document.querySelector('[data-testid="json-reply"]').textContent.includes('"ok": true'));
  ok((await status(page)).emotion.name === "surprised", "emotion not applied");
  await page.locator('[data-testid="json-input"]').fill('{"cmd":"setEmotion","emotion":"ecstatic"}');
  await page.click('[data-testid="json-send"]');
  await waitFor(page, () => document.querySelector('[data-testid="json-reply"]').textContent.includes('"ok": false'));
  const ev = await page.locator('[data-testid="event-log"]').textContent();
  ok(ev.includes("command"), "events not logged");
  await page.screenshot({ path: path.join(shotDir, "studio-developer.png") });
  return true;
});

await check("lobby environment: a real room around the robot (floor, walls, desk, glass wall), camera stays inside", async () => {
  await page.selectOption('[data-testid="bg-select"]', "lobby");
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const v = window.viewer;
    const lobby = v.scene.getObjectByName("Lobby");
    v.setCameraPreset("full", false, window.robot);
    return { has: !!lobby, kids: lobby?.children.length ?? 0, grid: v.scene.children.some((c) => c.type === "GridHelper" && c.visible), maxDist: v.controls.maxDistance };
  });
  ok(r.has && r.kids > 60, "lobby not built: " + JSON.stringify(r));
  ok(!r.grid && r.maxDist <= 6, "studio floor/grid should be hidden and orbit limited inside the room: " + JSON.stringify(r));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shotDir, "studio-lobby.png") });
  await page.selectOption('[data-testid="bg-select"]', "studio");
  await page.waitForTimeout(500);
  const gone = await page.evaluate(() => !window.viewer.scene.getObjectByName("Lobby"));
  ok(gone, "lobby should be removed when switching back");
  return r;
});

await check("lighting controls change the real lights and exposure", async () => {
  await page.locator('[data-testid="light-intensity"]').fill("4.5");
  await page.locator('[data-testid="light-angle"]').fill("-90");
  await page.locator('[data-testid="exposure"]').fill("1.6");
  await page.waitForTimeout(300);
  const l = await page.evaluate(() => ({ key: window.viewer.light, exposure: window.viewer.renderer.toneMappingExposure }));
  ok(l.key.intensity === 4.5 && l.key.angleDeg === -90 && Math.abs(l.exposure - 1.6) < 1e-6, JSON.stringify(l));
  await page.selectOption('[data-testid="bg-select"]', "light");
  await page.waitForTimeout(300);
  const bg = await page.evaluate(() => window.viewer.scene.background?.getHexString());
  ok(bg === "dfe5ee", "background not applied: " + bg);
  await page.screenshot({ path: path.join(shotDir, "studio-lighting-light-bg.png") });
  await page.selectOption('[data-testid="bg-select"]', "studio");
  await page.locator('[data-testid="light-intensity"]').fill("2.4");
  await page.locator('[data-testid="light-angle"]').fill("31");
  await page.locator('[data-testid="exposure"]').fill("1.05");
  return l;
});

await check("developer panel shows live FPS, draw calls and engine CPU time", async () => {
  await page.waitForTimeout(1200);
  const stats = await page.evaluate(() => ({ ...window.viewer.stats, engineMs: window.studio.engineMs }));
  ok(stats.fps > 0 && stats.calls > 0 && stats.triangles > 1000, JSON.stringify(stats));
  ok(stats.engineMs < 5, "engine too slow: " + stats.engineMs);
  return { ...stats, note: "software WebGL (SwiftShader): FPS is CPU-rasterised, not representative of a GPU" };
});

await check("lip-sync from real audio: vowels.wav drives the matching mouth shapes in sync with the audio clock", async () => {
  await page.click('[data-testid="reset"]');
  await page.evaluate(() => window.studio.selectBone(null)); // hide the joint-pick marker in the screenshot
  await page.click('[data-testid="tab-Audio"]');
  // sample the mouth morphs at high rate while the audio plays (render loop stopped, own fast loop).
  // The sampler starts first and waits for playback so no part of the audio is missed.
  const sampler = page.evaluate(async () => {
    const r = window.robot;
    window.viewer.stop();
    const names = ["aa", "E", "I", "O", "U", "SS"];
    const mesh = r.parts.meshes.get("Mouth");
    const out = [];
    let last = performance.now();
    const t0 = last;
    let started = false;
    while (performance.now() - t0 < 20000) {
      await new Promise((res) => setTimeout(res, 6));
      const now = performance.now();
      r.update((now - last) / 1000);
      last = now;
      if (r.lipsync.active) started = true;
      else if (started) break;
      if (r.lipsync.active) {
        let best = null, bv = 0.15;
        for (const n of names) { const v = mesh.morphTargetInfluences[mesh.morphTargetDictionary["viseme_" + n]]; if (v > bv) { bv = v; best = n; } }
        out.push([+r.lipsync.currentTime.toFixed(3), best, +bv.toFixed(2)]);
      }
    }
    window.viewer.start();
    return out;
  });
  await page.click('[data-testid="demo-vowels"]');
  const samples = await sampler;
  ok(samples.length > 100, "too few samples: " + samples.length);
  const truth = [["aa", 0.0], ["E", 0.54], ["I", 1.08], ["O", 1.62], ["U", 2.16]].map(([v, s]) => ({ v, a: s + 0.12, b: s + 0.30 }));
  truth.push({ v: "SS", a: 2.7 + 0.1, b: 2.7 + 0.25 });
  const rep = {};
  for (const seg of truth) {
    const inSeg = samples.filter(([t]) => t >= seg.a && t <= seg.b);
    const hit = inSeg.filter(([, b]) => b === seg.v).length;
    rep[seg.v] = `${hit}/${inSeg.length}`;
    ok(inSeg.length >= 3 && hit / inSeg.length >= 0.6, `viseme ${seg.v}: only ${hit}/${inSeg.length} samples matched`);
  }
  // silence between vowels: mouth is (almost) closed
  const sil = samples.filter(([t]) => t >= 0.43 && t <= 0.5);
  ok(sil.filter(([, b]) => b !== null).length / Math.max(1, sil.length) < 0.35, "mouth open during silence");
  await page.screenshot({ path: path.join(shotDir, "studio-audio.png") });
  return rep;
});

await check("hybrid sync: hello.wav + text 'hello' -> mouth closed in leading/trailing silence and open during speech", async () => {
  const sampler = page.evaluate(async () => {
    const r = window.robot;
    window.viewer.stop();
    const mesh = r.parts.meshes.get("Mouth");
    const open = (t) => { let sum = 0; for (const [n, i] of Object.entries(mesh.morphTargetDictionary)) if (n.startsWith("viseme_") && n !== "viseme_sil") sum += mesh.morphTargetInfluences[i]; return sum; };
    const out = [];
    let last = performance.now(); const t0 = last; let started = false;
    while (performance.now() - t0 < 20000) {
      await new Promise((res) => setTimeout(res, 6));
      const now = performance.now(); r.update((now - last) / 1000); last = now;
      if (r.lipsync.active) started = true; else if (started) break;
      if (r.lipsync.active) out.push([r.lipsync.currentTime, open()]);
    }
    window.viewer.start();
    return out;
  });
  await page.click('[data-testid="demo-hello"]');
  const s = await sampler;
  const lead = s.filter(([t]) => t > 0.02 && t < 0.15).map((x) => x[1]);
  const speech = s.filter(([t]) => t > 0.3 && t < 0.62).map((x) => x[1]);
  const tail = s.filter(([t]) => t > 0.85 && t < 1.0).map((x) => x[1]);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  ok(avg(speech) > 0.5, "mouth should be open during speech: " + avg(speech));
  ok(avg(lead) < 0.2 && avg(tail) < 0.2, `mouth should be closed in silence: lead ${avg(lead)} tail ${avg(tail)}`);
  return { lead: +avg(lead).toFixed(2), speech: +avg(speech).toFixed(2), tail: +avg(tail).toFixed(2) };
});

await check("text speech (EN and AR, silent preview) animates the mouth, gestures, then returns to idle", async () => {
  await page.click('[data-testid="reset"]');
  await page.locator('[data-testid="speak-text"]').fill("Hello, nice to meet you.");
  await page.locator('label:has-text("Silent preview") input').check();
  for (const text of ["Hello, nice to meet you.", "مرحبا، تشرفت بمعرفتك."]) {
    await page.locator('[data-testid="speak-text"]').fill(text);
    await page.click('[data-testid="speak-btn"]');
    await waitFor(page, () => window.robot.speaking, null, 3000);
    const seen = await page.evaluate(async () => {
      const r = window.robot; const set = new Set(); let gesture = false;
      const t0 = performance.now();
      while (r.speaking && performance.now() - t0 < 60000) {
        await new Promise((res) => setTimeout(res, 30));
        for (const [k, v] of Object.entries(r.lipsync.currentWeights)) if (v > 0.4) set.add(k);
        if (r.animation.ownerOf("armR")?.name === "talkR") gesture = true;
      }
      return { shapes: [...set], gesture };
    });
    ok(seen.shapes.length >= 3, "few mouth shapes: " + seen.shapes);
    ok(seen.gesture, "no talking gesture");
  }
  await waitFor(page, () => !window.robot.speaking && window.robot.stateMachine.state === "idle", null, 60000);
  return true;
});

await check("quality levels change the real render settings (pixel ratio, shadows)", async () => {
  const q = {};
  for (const level of ["low", "medium", "high"]) {
    await page.selectOption('[data-testid="quality-select"]', level);
    await page.waitForTimeout(500);
    q[level] = await page.evaluate(() => ({ pr: window.viewer.renderer.getPixelRatio(), shadows: window.viewer.renderer.shadowMap.enabled }));
  }
  ok(q.low.shadows === false && q.high.shadows === true && q.low.pr <= q.high.pr, JSON.stringify(q));
  // selective bloom: on only at "high"; the stats then cover several passes
  const b = await page.evaluate(() => ({ bloom: window.viewer.bloom, layers: [...window.robot.parts.meshes.values()].filter((m) => m.layers.isEnabled(1)).map((m) => m.name) }));
  ok(b.bloom === true && b.layers.includes("Glow") && b.layers.includes("Mouth") && !b.layers.includes("Body_Shell"), "bloom not selective: " + JSON.stringify(b));
  // stats refresh every ~0.5 s of frames and the software rasteriser is slow: wait for a snapshot taken after the switch
  const fresh = async () => {
    await page.evaluate(() => (window.__stats0 = window.viewer.stats));
    await page.waitForFunction(() => window.viewer.stats !== window.__stats0, null, { timeout: 60000, polling: 100 });
    await page.evaluate(() => (window.__stats0 = window.viewer.stats));
    await page.waitForFunction(() => window.viewer.stats !== window.__stats0, null, { timeout: 60000, polling: 100 });
    return page.evaluate(() => window.viewer.stats.calls);
  };
  const calls = await fresh();
  await page.selectOption('[data-testid="quality-select"]', "medium");
  const off = await page.evaluate(() => window.viewer.bloom);
  ok(off === false, "bloom should be off at medium");
  const plain = await fresh();
  ok(calls >= plain * 1.5, `stats should count all bloom passes: ${calls} calls with bloom vs ${plain} without`);
  q.bloom = b;
  return q;
});

await check("style switching loads all 5 designs and does not leak GPU memory", async () => {
  const mem = [];
  for (let round = 0; round < 2; round++) {
    for (const s of ["friendly", "futuristic", "premium", "concierge", "mascot"]) {
      await page.selectOption('[data-testid="style-select"]', s);
      await page.waitForFunction((st) => window.studio.style === st && window.robot, s, { timeout: 20000 });
      await page.waitForTimeout(500);
      mem.push(await page.evaluate(() => ({ g: window.viewer.renderer.info.memory.geometries, t: window.viewer.renderer.info.memory.textures })));
      if (round === 0) {
        await page.click('[data-testid="cam-full"]');
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(shotDir, `studio-style-${s}.png`) });
      }
    }
  }
  ok(mem[9].g <= mem[4].g + 2 && mem[9].t <= mem[4].t + 1, "geometry/texture count grew: " + JSON.stringify(mem));
  return { geometries: mem.map((m) => m.g) };
});

await check("window resize keeps the canvas sized to its container", async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(600);
  const a = await page.evaluate(() => { const c = document.querySelector("canvas"), p = c.parentElement; return [c.clientWidth, p.clientWidth, c.width, window.viewer.camera.aspect]; });
  ok(Math.abs(a[0] - a[1]) <= 1, "canvas not matching container");
  ok(Math.abs(a[3] - a[1] / (await page.evaluate(() => document.querySelector("canvas").clientHeight))) < 0.02, "aspect not updated");
  await page.setViewportSize({ width: 1440, height: 900 });
  return a;
});

await check("Arabic UI: RTL layout and translated labels", async () => {
  await page.click('[data-testid="lang"]');
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => ({ dir: document.documentElement.dir, tab: document.querySelector('[data-testid="tab-Motion"]').textContent }));
  ok(d.dir === "rtl" && d.tab === "الحركات", JSON.stringify(d));
  await page.click('[data-testid="tab-Motion"]');
  await page.screenshot({ path: path.join(shotDir, "studio-arabic.png") });
  await page.click('[data-testid="lang"]');
  return d;
});

await check("WebSocket bridge: a server drives the robot with JSON and receives results + events", async () => {
  const wss = new WebSocketServer({ port: 8787 });
  const received = [];
  let sock;
  const connected = new Promise((res) => wss.on("connection", (s) => { sock = s; s.on("message", (m) => received.push(JSON.parse(String(m)))); res(); }));
  await page.click('[data-testid="tab-Developer"]');
  await page.click('button:has-text("Connect")');
  await connected;
  sock.send(JSON.stringify({ id: "w1", cmd: "sequence", steps: [{ cmd: "setEmotion", emotion: "happy" }, { cmd: "setState", state: "listening" }, { cmd: "moveHead", yaw: 30 }] }));
  sock.send(JSON.stringify({ id: "w2", cmd: "nope" }));
  await waitFor(page, () => window.robot.getStatus().state === "listening" && window.robot.getStatus().emotion.name === "friendly" || window.robot.getStatus().state === "listening");
  const t0 = Date.now();
  while (received.filter((m) => m.id).length < 2 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
  const r1 = received.find((m) => m.id === "w1");
  const r2 = received.find((m) => m.id === "w2");
  ok(r1?.ok === true, "no ok reply " + JSON.stringify(r1));
  ok(r2?.ok === false && /unknown command/.test(r2.error), "no error reply " + JSON.stringify(r2));
  ok(received.some((m) => m.event === "state" && m.data.to === "listening"), "state event not streamed");
  await robotWait(page, 1.0);
  const yaw = await page.evaluate(() => window.robot.joints.currentEuler("head").y + window.robot.joints.currentEuler("neck").y);
  ok(Math.abs(yaw - 30) < 3, "head did not follow the command: " + yaw);
  await page.click('button:has-text("Disconnect")');
  wss.close();
  return { replies: received.filter((m) => m.id).length, events: received.filter((m) => m.event).length };
});

await check("Remote HTTP API: POST a JSON motion + commands from outside, the browser robot performs them", async () => {
  const srv = spawn("node", ["tools/remote_api_server.mjs"], { cwd: root, env: { ...process.env, PORT: "8788", API_KEY: "k" }, stdio: "ignore" });
  const H = { authorization: "Bearer k", "content-type": "application/json" };
  const api = (p, init = {}) => fetch(`http://localhost:8788${p}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:8788/v1/health", { headers: H })).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
    ok((await fetch("http://localhost:8788/v1/health")).status === 401, "API key not enforced");
    await page.click('[data-testid="tab-Developer"]');
    await page.locator('input[aria-label="WebSocket URL"]').fill("ws://localhost:8788");
    await page.click('button:has-text("Connect")');
    const t0 = Date.now();
    while ((await (await api("/v1/health")).json()).robots < 1 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
    const motion = { name: "remoteNod", duration: 1.6, keys: [{ t: 0, head: { pitch: 0 }, armL: { shoulder: 0, elbow: 0 } }, { t: 0.5, head: { pitch: -20 }, armL: { shoulder: 80, elbow: 30 } }, { t: 1.6, head: { pitch: 0 }, armL: { shoulder: 0, elbow: 0 } }] };
    const reg = await api("/v1/motions?play=1", { method: "POST", body: JSON.stringify(motion) });
    const regBody = await reg.json();
    ok(reg.status === 201 && regBody.ok, "register failed " + JSON.stringify(regBody));
    await waitFor(page, () => window.robot.animation.isPlaying("remoteNod"), null, 20000);
    const bad = await api("/v1/motions", { method: "POST", body: JSON.stringify({ name: "x" }) });
    const badBody = await bad.json();
    ok(bad.status === 400 && /duration/.test(badBody.error), "invalid motion should return 400 with details: " + JSON.stringify(badBody));
    const cmd = await (await api("/v1/command", { method: "POST", body: JSON.stringify({ cmd: "setEmotion", emotion: "curious" }) })).json();
    ok(cmd.ok, "command failed " + JSON.stringify(cmd));
    const st = await (await api("/v1/status")).json();
    ok(st.result.emotion.name === "curious", "status mismatch " + JSON.stringify(st));
    const list = await (await api("/v1/motions")).json();
    ok(list.result.custom.includes("remoteNod"), "motion not listed");
    const schema = await (await api("/v1/schema/motion")).json();
    ok(schema.result.title === "RobotMotion", "schema missing");
    await page.click('button:has-text("Disconnect")');
    return { registered: regBody.result.name, status: st.result.emotion.name };
  } finally {
    srv.kill();
  }
});

await check("no uncaught errors or console errors during the whole session", async () => {
  ok(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
});
await ctx.close();

console.log("\nIntegration examples");
for (const [name, url] of [["minimal embed (plain three.js)", "examples/minimal.html"], ["React Three Fiber adapter", "examples/r3f.html"]]) {
  await check(`${name}: renders the robot and the Robot API works`, async () => {
    const c = await browser.newContext({ viewport: { width: 800, height: 700 } });
    const p = await c.newPage();
    const errs = [];
    p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(URL + url);
    await p.waitForFunction(() => window.robot, null, { timeout: 60000 });
    await p.evaluate(() => { window.robot.resetPose(); window.robot.playAnimation("greeting"); window.__t0 = window.robot.time; });
    await p.waitForFunction(() => window.robot.time > window.__t0 + 1.2, null, { timeout: 60000, polling: 100 });
    const y = await p.evaluate(() => { const r = window.robot; r.root.updateMatrixWorld(true); return r.root.worldToLocal(r.joints.bone("hand_R").getWorldPosition(r.root.position.clone())).y; });
    const lit = await p.evaluate(() => new Promise((res) => { const cv = document.querySelector("canvas"); requestAnimationFrame(() => { const g = document.createElement("canvas"); g.width = cv.width; g.height = cv.height; const x = g.getContext("2d"); x.drawImage(cv, 0, 0); const d = x.getImageData(0, 0, g.width, g.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 140 && d[i + 1] > 140) n++; res(n / (d.length / 4)); }); }));
    await p.screenshot({ path: path.join(shotDir, `example-${url.includes("r3f") ? "r3f" : "minimal"}.png`) });
    await c.close();
    ok(errs.length === 0, errs.join(" | "));
    ok(y > 0.9, "hand not raised " + y);
    return { handY: +y.toFixed(2), brightPixels: +lit.toFixed(3) };
  });
}

console.log("\nMobile layout (390x844, touch)");
{
  const m = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await check("phone layout: no horizontal scroll, canvas visible, tabs usable", async () => {
    const o = await m.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, canvasH: document.querySelector("canvas").clientHeight }));
    ok(o.sw <= o.cw + 1, "horizontal overflow " + JSON.stringify(o));
    ok(o.canvasH > 300, "canvas too small");
    const ov = await m.page.evaluate(() => { const t = document.querySelector(".toolbar").getBoundingClientRect(); const v = document.querySelector('[data-testid="viewport"]').getBoundingClientRect(); return { toolbarBottom: t.bottom, viewportTop: v.top }; });
    ok(ov.toolbarBottom <= ov.viewportTop + 1, "toolbar overlaps the 3D view on phones: " + JSON.stringify(ov));
    await m.page.click('[data-testid="tab-Audio"]');
    await m.page.screenshot({ path: path.join(shotDir, "studio-mobile.png") });
    return o;
  });
  await m.ctx.close();
}

console.log("\nGraceful fallback when WebGL is unavailable");
{
  const b2 = await chromium.launch({ executablePath: CHROME, args: ["--disable-3d-apis", "--disable-gpu", "--disable-webgl", "--disable-webgl2"] });
  const p2 = await (await b2.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await p2.goto(URL);
  await check("shows an explanatory message instead of crashing", async () => {
    await p2.waitForSelector('[role="alert"]', { timeout: 20000 });
    const txt = await p2.locator('[role="alert"]').textContent();
    ok(/WebGL/i.test(txt), txt);
    return txt.slice(0, 80);
  });
  await b2.close();
}

await browser.close();
kill();
const summary = { passed: results.filter((r) => r.ok).length, failed, total: results.length, results };
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(summary, null, 2));
console.log(`\nE2E: ${summary.passed}/${summary.total} passed`);
process.exit(failed ? 1 : 0);
