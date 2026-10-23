// Ask a question -> Gemini answers -> the robot thinks, speaks and reacts. See docs/GEMINI.md.
import {
  ProxyChatBackend, ProxyTtsBackend, RobotAssistant, RobotAvatar, RobotViewer, commandHelp, describeAction, failureMessage, listenOnce, speechRecognitionAvailable,
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
const STATUS: Record<string, string> = { idle: "جاهز", thinking: "يفكّر…", speaking: "يتحدّث", acting: "ينفّذ…", listening: "يستمع…", error: "حدث خطأ" };
const setStatus = (s: string) => {
  status.dataset.s = s;
  status.textContent = STATUS[s] ?? s;
  $("stop").style.display = s === "thinking" || s === "speaking" || s === "acting" ? "inline-block" : "none";
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
// orders: one log box per typed order, its lines tick off as the robot finishes each step; LLM-driven moves get a line of their own
let cmdBox: HTMLElement | null = null;
assistant.on("command", (e) => {
  if (current && !current.textContent) current.remove();
  cmdBox = bubble("cmd");
  e.actions.forEach((a, i) => {
    const l = document.createElement("div");
    l.className = "wait";
    l.dataset.i = String(i);
    l.textContent = `… ${describeAction(a, e.lang)}`;
    cmdBox!.appendChild(l);
  });
  current = bubble("bot"); // the spoken "okay" / explanation shows up below the log
});
assistant.on("action", (e) => {
  const lang = lang_() ;
  const note = failureMessage(e.result, lang);
  if (e.source === "chat" && cmdBox) {
    const l = cmdBox.querySelector<HTMLElement>(`[data-i="${e.index}"]`);
    if (l) {
      l.className = e.result.ok ? "" : "bad";
      l.textContent = `${e.result.ok ? "✓" : "✗"} ${describeAction(e.action, lang)}${e.result.moved !== undefined && e.action.type === "move" ? ` (${e.result.moved.toFixed(1)} م)` : ""}`;
    }
  } else if (e.source === "llm") {
    const d = bubble("cmd");
    const l = document.createElement("div");
    l.className = e.result.ok ? "" : "bad";
    l.textContent = `${e.result.ok ? "✓" : "✗"} ${describeAction(e.action, lang)}${note ? ` — ${note}` : ""}`;
    d.appendChild(l);
  }
});
assistant.on("error", (e) => bubble("bot err", `${e.stage === "tts" ? "الصوت" : "الإجابة"}: ${e.message}`));

const lang_ = () => (lang.value === "en" ? "en" : "ar");
async function ask(text: string) {
  if (!text.trim()) return;
  q.value = "";
  bubble("user", text);
  current = bubble("bot");
  const r = await assistant.ask(text);
  if (r.error || !r.text) current?.remove();
}
// quick orders (they work offline too: the robot understands them without Gemini)
const CHIPS: [string, string][] = [["⬆ تقدم", "تقدم للأمام"], ["⬇ تراجع", "تراجع للخلف"], ["↶ يساراً", "استدر يسارا"], ["↷ يميناً", "استدر يمينا"], ["👋 لوّح", "لوّح"], ["🏢 المكتب", "اذهب إلى المكتب"], ["🏠 مكانك", "عد إلى مكانك"], ["✋ قف", "قف"], ["؟ الأوامر", ""]];
for (const [label, cmd] of CHIPS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", () => {
    if (cmd) void ask(cmd);
    else bubble("bot hint", commandHelp(lang_()));
  });
  $("chips").appendChild(b);
}
$("form").addEventListener("submit", (e) => { e.preventDefault(); void ask(q.value); });
$("stop").addEventListener("click", () => assistant.cancel());
const mic = $("mic");
if (!speechRecognitionAvailable()) mic.style.display = "none";
mic.addEventListener("click", async () => {
  assistant.cancel({ motion: false }); // talking over the robot interrupts its speech, not its walk
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
