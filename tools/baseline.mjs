// Baseline realism renderer: screenshots all 5 styles through the standard pose list
// (tools/baseline_poses.json) then stitches per-style contact sheets with montage.py.
//   node tools/baseline.mjs --tag before [--outDir docs/screenshots/baseline] [--montage 1]
// Requires the dev server (npm run dev) on :5173 unless --serve starts it.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.join(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const TAG = arg("tag", "before");
const OUT_DIR = path.join(ROOT, arg("outDir", "docs/screenshots/baseline"));
const STYLE_DIR = path.join(OUT_DIR, TAG);
const MONTAGE = arg("montage", "1") === "1";
const PY = path.join(ROOT, ".venv-bpy/Scripts/python.exe");
const poses = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/baseline_poses.json"), "utf8"));
fs.mkdirSync(STYLE_DIR, { recursive: true });

const CHROME = process.env.CHROME_PATH || [
  chromium.executablePath(),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error("Chromium not found. Run npx playwright-core install chromium or set CHROME_PATH.");

let server;
if (arg("serve", "0") === "1") {
  server = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", "5173", "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  const up = await (async () => { for (let i = 0; i < 300; i++) { try { const r = await fetch("http://127.0.0.1:5173/examples/minimal.html"); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 1000)); } return false; })();
  if (!up) throw new Error("dev server did not come up on :5173");
  console.log("[baseline] dev server ready");
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 420, height: 520 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

const files = []; // [label, path] across all styles
try {
  for (const style of poses.styles) {
    await page.goto("http://127.0.0.1:5173/examples/minimal.html");
    await page.waitForFunction(() => window.robot, null, { timeout: 60000 });
    if (style !== "premium") {
      await page.evaluate(async (s) => {
        const { RobotAvatar } = await import("/src/index.ts");
        window.viewer.remove(window.robot);
        window.robot?.dispose();
        window.robot = await RobotAvatar.load(`/models/robot_${s}.glb`);
        window.viewer.add(window.robot);
      }, style);
    }
    await page.evaluate(() => { window.viewer.stop(); window.robot.stopSpeech(); });

    const styleFiles = [];
    for (const [i, pose] of poses.poses.entries()) {
      await page.evaluate(async ({ js, secs, cam }) => {
        const r = window.robot;
        r.resetPose({ position: true });
        for (let k = 0; k < 30; k++) r.update(1 / 60);
        if (js) eval(js);
        const n = Math.round(parseFloat(secs) * 60);
        for (let k = 0; k < n; k++) r.update(1 / 60);
        if (cam === "q") {
          window.viewer.setCameraPreset("full", false, r);
          const v = window.viewer, t = v.controls.target.clone();
          const d = v.camera.position.distanceTo(t) * 0.95;
          v.camera.position.set(t.x + d * 0.55, t.y + 0.12, t.z + d * 0.84);
          v.controls.target.set(t.x, t.y + 0.08, t.z);
          v.controls.update();
        } else window.viewer.setCameraPreset(cam, false, r);
        window.viewer.frame(0);
      }, { js: pose.js, secs: pose.secs, cam: pose.cam });

      const f = path.join(STYLE_DIR, `${style}_${String(i).padStart(2, "0")}_${pose.name.replace(/\s+/g, "-")}.png`);
      await page.screenshot({ path: f });
      styleFiles.push([pose.name, f]);
      files.push([`${style} ${pose.name}`, f]);
    }
    console.log(`[baseline] ${style}: ${styleFiles.length} shots`);
  }
} finally {
  await browser.close();
  if (server) {
    server.kill();
    if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

if (MONTAGE) {
  const cols = arg("cols", "3");
  // per-style sheets
  for (const style of poses.styles) {
    const styleFiles = files.filter(([n]) => n.startsWith(style + " ")).map(([n, f]) => [n.slice(style.length + 1), f]);
    const list = path.join(STYLE_DIR, `_${style}_files.json`);
    fs.writeFileSync(list, JSON.stringify(styleFiles));
    spawnSync(PY, [path.join(ROOT, "tools/montage.py"), path.join(STYLE_DIR, `sheet_${TAG}_${style}.png`), cols, list], { cwd: ROOT });
  }
  // overview: first pose of every style
  const overview = [];
  for (const style of poses.styles) overview.push(files[files.findIndex(([n]) => n === `${style} ${poses.poses[0].name}`)]);
  const list2 = path.join(STYLE_DIR, "_overview_files.json");
  fs.writeFileSync(list2, JSON.stringify(overview));
  spawnSync(PY, [path.join(ROOT, "tools/montage.py"), path.join(STYLE_DIR, `sheet_${TAG}_overview.png`), poses.styles.length, list2], { cwd: ROOT });
}
console.log(`[baseline] done -> ${STYLE_DIR}`);
