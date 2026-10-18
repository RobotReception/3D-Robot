// usage: node tools/shot.mjs <url-path> <out.png> "<js to run in page>" [waitMs] [w] [h]
import { chromium } from "playwright-core";
const [, , path, out, js = "", wait = "1500", w = "900", h = "900"] = process.argv;
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5173${path}`);
await page.waitForFunction(() => window.robot, null, { timeout: 60000 });
if (js) await page.evaluate(js);
await page.waitForTimeout(+wait);
await page.screenshot({ path: out });
console.log(logs.slice(0, 15).join("\n"));
await browser.close();
