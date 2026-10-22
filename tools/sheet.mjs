// Renders a list of poses to a contact sheet. usage: node tools/sheet.mjs out.png style cam "name|js|seconds" ...
// Screenshots go to SHEET_DIR (env, default tests/e2e/out/sheet); PREFIX names the files.json chunk.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
const [, , out, style, cam, ...items] = process.argv;
const ROOT = path.join(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "../..");
const SHEET_DIR = process.env.SHEET_DIR ?? path.join(ROOT, "tests/e2e/out/sheet");
fs.mkdirSync(SHEET_DIR, { recursive: true });
const CHROME = process.env.CHROME_PATH || [
  chromium.executablePath(),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error("Chromium not found. Run npx playwright-core install chromium or set CHROME_PATH.");
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 420, height: 520 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.log("[err]", m.text()));
await page.goto("http://localhost:5173/examples/minimal.html");
await page.waitForFunction(() => window.robot, null, { timeout: 60000 });
if (style !== "premium") {
  await page.evaluate(async (style) => {
    const { RobotAvatar } = await import("/src/index.ts");
    window.viewer.remove(window.robot);
    window.robot = await RobotAvatar.load(`/models/robot_${style}.glb`);
    window.viewer.add(window.robot);
  }, style);
}
await page.evaluate(() => { window.viewer.stop(); window.robot.stopSpeech(); });
const files = [];
for (const [i, it] of items.entries()) {
  const [name, js, secs, cam1] = it.split("|");
  await page.evaluate(async ({ js, secs, cam }) => {
    const r = window.robot;
    r.resetPose({ position: true });
    for (let k = 0; k < 30; k++) r.update(1 / 60);
    eval(js);
    const n = Math.round(parseFloat(secs) * 60);
    for (let k = 0; k < n; k++) r.update(1 / 60);
    if (cam === "q") { window.viewer.setCameraPreset("full", false, r); const v = window.viewer; const t = v.controls.target.clone(); const d = v.camera.position.distanceTo(t) * 0.95; v.camera.position.set(t.x + d * 0.55, t.y + 0.12, t.z + d * 0.84); v.controls.target.set(t.x, t.y + 0.08, t.z); v.controls.update(); }
    else window.viewer.setCameraPreset(cam, false, r);
    window.viewer.frame(0);
  }, { js, secs, cam: cam1 || cam });
  const f = path.join(SHEET_DIR, `sheet_${process.env.PREFIX || ""}${i}.png`);
  await page.screenshot({ path: f });
  files.push([name, f]);
}
await browser.close();
fs.writeFileSync(path.join(SHEET_DIR, `sheet_${process.env.PREFIX || ""}files.json`), JSON.stringify(files));
console.log(JSON.stringify(files.map((f) => f[0])));
