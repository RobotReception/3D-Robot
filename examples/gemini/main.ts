// Ask a question -> Gemini answers -> the robot thinks, speaks and reacts. See docs/GEMINI.md.
import {
  ProxyChatBackend, ProxyTtsBackend, RobotAssistant, RobotAvatar, RobotViewer, listenOnce, speechRecognitionAvailable,
} from "../../src";
import { BRAND_PRESETS, DEFAULT_BRAND } from "../../src/studio/brands";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const style = params.get("style") ?? "concierge"; // concierge | mascot | premium | friendly | futuristic
const base = "../"; // this page lives in /examples/, models / logos / the API are one level up

const viewer = new RobotViewer($("stage"), { quality: (params.get("quality") as "low" | "medium" | "high") ?? "high", background: "lobby" });
const robot = await RobotAvatar.load(`${base}models/robot_${style}.glb`);
viewer.add(robot);
viewer.setCameraPreset("upper", false, robot);
{ // a little further back so the head is fully in frame next to the chat panel
  const t = viewer.controls.target;
  viewer.camera.position.sub(t).multiplyScalar(1.3).add(t);
  viewer.controls.update();
}
viewer.start();
robot.stateMachine.userTarget = viewer.camera; // eyes on the user while listening / speaking

// University identity (colours, chest logo, lobby sign); ?brand=none for the original look
if (params.get("brand") !== "none") {
  const b = BRAND_PRESETS[DEFAULT_BRAND];
  robot.setColors(b.colors);
  if (b.logo) {
    void robot.setLogo(`${base}${b.logo}`);
    void viewer.setLobbyBrand(b.lobby ? { ...b.lobby, logo: `${base}${b.logo}` } : null);
  }
}

const assistant = new RobotAssistant(robot, {
  chat: new ProxyChatBackend({ url: `${base}api/chat` }),
  tts: new ProxyTtsBackend({ url: `${base}api/tts`, voice: params.get("voice") ?? undefined }),
  persona: { name: "Razi", organization: "Al-Razi University", role: "reception assistant" },
});

// ---- UI
const log = $("log"), q = $<HTMLInputElement>("q"), status = $("status"), lang = $<HTMLSelectElement>("lang");
const STATUS: Record<string, string> = { idle: "جاهز", thinking: "يفكّر…", speaking: "يتحدّث", listening: "يستمع…", error: "حدث خطأ" };
const setStatus = (s: string) => {
  status.dataset.s = s;
  status.textContent = STATUS[s] ?? s;
  $("stop").style.display = s === "thinking" || s === "speaking" ? "inline-block" : "none";
};
const bubble = (cls: string, text = "") => {
  log.querySelector(".hint")?.remove();
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
};
let current: HTMLElement | null = null;
assistant.on("state", (e) => setStatus(e.state));
assistant.on("sentence", (e) => { // the text appears sentence by sentence, as it is spoken
  if (current) current.textContent += (current.textContent ? " " : "") + e.text;
  log.scrollTop = log.scrollHeight;
});
assistant.on("error", (e) => bubble("bot err", `${e.stage === "tts" ? "الصوت" : "الإجابة"}: ${e.message}`));

async function ask(text: string) {
  if (!text.trim()) return;
  q.value = "";
  bubble("user", text);
  current = bubble("bot");
  const r = await assistant.ask(text);
  if (r.error || !r.text) current?.remove();
}
$("form").addEventListener("submit", (e) => { e.preventDefault(); void ask(q.value); });
$("stop").addEventListener("click", () => assistant.cancel());
const mic = $("mic");
if (!speechRecognitionAvailable()) mic.style.display = "none";
mic.addEventListener("click", async () => {
  assistant.cancel(); // talking over the robot interrupts it
  setStatus("listening");
  try {
    const text = await listenOnce(robot, { lang: lang.value === "en" ? "en-US" : "ar-SA", onInterim: (t) => (q.value = t) });
    if (text) await ask(text);
    else { setStatus("idle"); robot.setState("idle"); }
  } catch (err) {
    setStatus("error");
    bubble("bot err", (err as Error).message);
  }
});
lang.addEventListener("change", () => { (assistant.options as { language?: string }).language = lang.value === "auto" ? undefined : lang.value; });
(assistant.options as { language?: string }).language = "ar";

Object.assign(window, { robot, viewer, assistant });
