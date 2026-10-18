// Renders a list of poses to a contact sheet. usage: node tools/sheet.mjs out.png style cam "name|js|seconds" ...
import { chromium } from "playwright-core";
import fs from "node:fs";
const [, , out, style, cam, ...items] = process.argv;
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
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
  const [name, js, secs] = it.split("|");
  await page.evaluate(async ({ js, secs, cam }) => {
    const r = window.robot;
    r.resetPose({ position: true });
    for (let k = 0; k < 30; k++) r.update(1 / 60);
    eval(js);
    const n = Math.round(parseFloat(secs) * 60);
    for (let k = 0; k < n; k++) r.update(1 / 60);
    window.viewer.setCameraPreset(cam, false, r);
    window.viewer.frame(0);
  }, { js, secs, cam });
  const f = `/tmp/claude-0/sheet_${i}.png`;
  await page.screenshot({ path: f });
  files.push([name, f]);
}
await browser.close();
fs.writeFileSync("/tmp/claude-0/sheet_files.json", JSON.stringify(files));
console.log(JSON.stringify(files.map((f) => f[0])));
