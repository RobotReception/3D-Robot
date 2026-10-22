// Quick phase-2 visual probe: one style, idle + happy face shots.
//   node tools/probe_phase2.mjs friendly [outDir]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const STYLE = process.argv[2] || "friendly";
const OUT = process.argv[3] || path.join(process.env.TEMP || "C:/Users/MO-ALS~1/AppData/Local/Temp/opencode", "probe");
fs.mkdirSync(OUT, { recursive: true });

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error("no chromium");

const server = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", "5173", "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
const up = await (async () => { for (let i = 0; i < 240; i++) { try { const r = await fetch("http://127.0.0.1:5173/examples/minimal.html"); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 1000)); } return false; })();
if (!up) { server.kill(); throw new Error("dev server did not come up"); }
console.log("[probe] dev server ready");

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 640, height: 760 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[page error]", m.text()); });
try {
  await page.goto("http://127.0.0.1:5173/examples/minimal.html");
  await page.waitForFunction(() => window.robot, null, { timeout: 60000 });
  await page.evaluate(async (s) => {
    const { RobotAvatar } = await import("/src/index.ts");
    window.viewer.remove(window.robot);
    window.robot?.dispose();
    window.robot = await RobotAvatar.load(`/models/robot_${s}.glb`);
    window.viewer.add(window.robot);
  }, STYLE);
  await page.evaluate(() => { window.viewer.stop(); window.robot.stopSpeech(); window.robot.eyeGlow = true; });

  // 3/4 body
  await page.evaluate(() => {
    const r = window.robot;
    r.resetPose({ position: true });
    for (let k = 0; k < 30; k++) r.update(1 / 60);
    const v = window.viewer, t = v.controls.target.clone();
    const d = v.camera.position.distanceTo(t) * 0.95;
    v.camera.position.set(t.x + d * 0.55, t.y + 0.12, t.z + d * 0.84);
    v.controls.target.set(t.x, t.y + 0.08, t.z);
    v.controls.update();
    window.viewer.frame(0);
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${STYLE}_probe_body.png`) });

  // face closeup (happy)
  await page.evaluate(() => {
    const r = window.robot;
    r.resetPose({ position: true });
    r.setEmotion("happy");
    for (let k = 0; k < 42; k++) r.update(1 / 60);
    window.viewer.setCameraPreset("face", false, r);
    window.viewer.frame(0);
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${STYLE}_probe_face.png`) });
  console.log(`[probe] done -> ${OUT}`);
} finally {
  await browser.close();
  server.kill();
  const { spawnSync } = await import("node:child_process");
  if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
}
