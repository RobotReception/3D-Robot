import { describe, expect, it } from "vitest";
import { executeAction, executeActions, LOBBY_PLACES, parseActionTag, type ActionContext, type ActionResult } from "../src/engine/actions";
import { RobotAssistant, DirectiveParser, type ChatBackend, type TtsBackend } from "../src/engine/assistant";
import { buildSystemPrompt } from "../src/engine/assistantPrompt";
import { lobbyWorld } from "../src/viewer/environments/lobby";
import { makeRobot } from "./helpers/robot";
import type { RobotAvatar } from "../src/engine/RobotAvatar";

const DEG = 180 / Math.PI;
/** advance robot time until the promise settles (max 40 s) */
async function drive<T>(r: RobotAvatar, p: Promise<T>, maxSeconds = 40): Promise<T> {
  let done = false;
  let value!: T;
  void p.then((v) => { done = true; value = v; });
  for (let i = 0; i < maxSeconds * 60 && !done; i++) {
    r.update(1 / 60);
    if (i % 4 === 0) await Promise.resolve();
    if (i % 30 === 0) await new Promise((x) => setTimeout(x, 0));
  }
  await new Promise((x) => setTimeout(x, 0));
  if (!done) throw new Error("promise did not settle in robot time");
  return value;
}
const ctxOf = (r: RobotAvatar): ActionContext => ({ places: LOBBY_PLACES, home: { x: r.root.position.x, z: r.root.position.z, facing: 0 } });
async function lobbyRobot() {
  const r = await makeRobot("concierge");
  r.world = lobbyWorld();
  r.root.position.set(0, 0, 1.5);
  return quietSpeech(r);
}
/** the real robot (walking, gestures, IK) with silent stand-ins for the audio parts, which need a browser */
function quietSpeech(r: RobotAvatar): RobotAvatar {
  let clock = 0;
  const fakeStream = () => {
    let dur = 0;
    let fin!: () => void;
    const finished = new Promise<void>((res) => (fin = res));
    const start = clock;
    return { pushPCM16: (c: Int16Array) => void (dur += c.length / 24000), pushVisemes: () => undefined, end: () => r.after(dur, fin), stop: () => fin(), time: () => clock - start, finished };
  };
  return new Proxy(r, {
    get(t, k) {
      if (k === "update") return (dt: number) => { clock += dt; t.update(dt); };
      if (k === "speakStream") return fakeStream;
      if (k === "speak") return (o: { text: string }) => { let fin!: () => void; const finished = new Promise<void>((res) => (fin = res)); r.after(0.3 + o.text.length * 0.05, fin); return { finished, stop: () => fin() }; };
      if (k === "stopSpeech") return () => undefined;
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
const yawDeg = (r: RobotAvatar) => ((((r.root.rotation.y * DEG) % 360) + 540) % 360) - 180;

describe("executeAction on a real robot in the lobby", () => {
  it("moves forward the asked distance in the direction it faces", async () => {
    const r = await lobbyRobot();
    const res = await drive(r, executeAction(r, { type: "move", dir: "forward", meters: 1 }, ctxOf(r)));
    expect(res.ok).toBe(true);
    expect(r.root.position.z).toBeCloseTo(2.5, 1);
    expect(Math.abs(r.root.position.x)).toBeLessThan(0.05);
  });
  it("turns left (positive yaw) and right, by the asked angle", async () => {
    const r = await lobbyRobot();
    await drive(r, executeAction(r, { type: "turn", deg: 90 }, ctxOf(r)));
    expect(yawDeg(r)).toBeCloseTo(90, -1);
    await drive(r, executeAction(r, { type: "turn", deg: -45 }, ctxOf(r)));
    expect(yawDeg(r)).toBeCloseTo(45, -1);
  });
  it("moving back or sideways relocates the robot but keeps it facing the same way", async () => {
    const r = await lobbyRobot();
    const z0 = r.root.position.z;
    await drive(r, executeAction(r, { type: "move", dir: "back", meters: 1 }, ctxOf(r)));
    expect(r.root.position.z).toBeCloseTo(z0 - 1, 1);
    expect(Math.abs(yawDeg(r))).toBeLessThan(3);
    const x0 = r.root.position.x;
    await drive(r, executeAction(r, { type: "move", dir: "left", meters: 1 }, ctxOf(r)));
    expect(r.root.position.x - x0).toBeCloseTo(1, 1); // robot's left = +x when facing +z
    expect(Math.abs(yawDeg(r))).toBeLessThan(3);
  });
  it("reports 'blocked' when furniture or walls stop the move, and never passes through", async () => {
    const r = await lobbyRobot();
    r.root.position.set(0, 0, 4.5); // the front wall is at z = 7.5
    const res = await drive(r, executeAction(r, { type: "move", dir: "forward", meters: 20 }, ctxOf(r)), 60);
    expect(res.ok).toBe(false);
    expect(["blocked", "unreachable"]).toContain(res.reason);
    expect(r.root.position.z).toBeLessThan(7.5); // inside the room
  });
  it("goes to a named place and faces the way the place says, then walks back home", async () => {
    const r = await lobbyRobot();
    const ctx = ctxOf(r);
    const res = await drive(r, executeAction(r, { type: "goto", place: "desk" }, ctx), 60);
    expect(res.ok).toBe(true);
    expect(Math.hypot(r.root.position.x - LOBBY_PLACES.desk.x, r.root.position.z - LOBBY_PLACES.desk.z)).toBeLessThan(0.3);
    expect(Math.abs(Math.abs(yawDeg(r)) - 180)).toBeLessThan(8);
    const back = await drive(r, executeAction(r, { type: "home" }, ctx), 60);
    expect(back.ok).toBe(true);
    expect(Math.hypot(r.root.position.x - ctx.home.x, r.root.position.z - ctx.home.z)).toBeLessThan(0.3);
  });
  it("an unknown place is 'invalid'; stop ends a walk in progress", async () => {
    const r = await lobbyRobot();
    expect((await executeAction(r, { type: "goto", place: "moon" }, ctxOf(r))).reason).toBe("invalid");
    const p = executeAction(r, { type: "move", dir: "forward", meters: 3 }, ctxOf(r));
    for (let i = 0; i < 60; i++) r.update(1 / 60);
    await executeAction(r, { type: "stop" }, ctxOf(r));
    const res = await drive(r, p, 5);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("interrupted");
  });
  it("runs a sequence in order (turn, then walk along the new heading, then a gesture)", async () => {
    const r = await lobbyRobot();
    const seen: string[] = [];
    const out = await drive(r, executeActions(r, [{ type: "turn", deg: -90 }, { type: "move", dir: "forward", meters: 1 }, { type: "gesture", name: "greeting" }], ctxOf(r)));
    out.forEach((x: ActionResult) => seen.push(x.action.type));
    expect(seen).toEqual(["turn", "move", "gesture"]);
    expect(r.root.position.x).toBeLessThan(-0.9); // facing -90° = toward -x
  });
  it("emotion and colour actions drive the face and the materials", async () => {
    const r = await lobbyRobot();
    await executeAction(r, { type: "emotion", name: "happy" }, ctxOf(r));
    expect(r.getStatus().emotion.name).toBe("happy");
    expect((await executeAction(r, { type: "color", part: "uniform", color: "#336699" }, ctxOf(r))).ok).toBe(true);
  });
});

describe("parseActionTag", () => {
  it("understands moves, turns, places, looks and rejects the rest", () => {
    expect(parseActionTag("forward:2")).toEqual({ type: "move", dir: "forward", meters: 2, speed: undefined });
    expect(parseActionTag("turn_right:45")).toEqual({ type: "turn", deg: -45 });
    expect(parseActionTag("turn_left")).toEqual({ type: "turn", deg: 90 });
    expect(parseActionTag("goto:desk")).toEqual({ type: "goto", place: "desk" });
    expect(parseActionTag("goto:moon")).toBeNull();
    expect(parseActionTag("look:user")).toEqual({ type: "look", target: "user" });
    expect(parseActionTag("forward:9999")).toMatchObject({ meters: 6 }); // clamped
    expect(parseActionTag("fly")).toBeNull();
    expect(parseActionTag("color:uniform:0080c6")).toEqual({ type: "color", part: "uniform", color: "#0080c6" });
    expect(parseActionTag("color:uniform:red")).toBeNull();
  });
  it("valid tags split across chunks come through", () => {
    const p = new DirectiveParser();
    const out = ["[action=got", "o:desk]Here. [action=forward:2]"].flatMap((c) => p.push(c)).concat(p.flush());
    expect(out.filter((x) => x.type === "tag").map((x) => (x as { tag: { value: { type: string } } }).tag.value.type)).toEqual(["goto", "move"]);
  });
  it("the system prompt teaches the tags (and can leave them out)", () => {
    expect(buildSystemPrompt()).toContain("[action=goto:PLACE]");
    expect(buildSystemPrompt()).toContain("desk");
    expect(buildSystemPrompt({ actions: false })).not.toContain("[action=");
    expect(buildSystemPrompt({ actions: { places: ["lab"] } })).toContain("lab");
  });
});

// ------------------------------------------------------------------ the assistant with orders
const toneTts = (calls: string[] = []): TtsBackend => ({
  sampleRate: 24000,
  async synth(text) {
    calls.push(text);
    return new Int16Array(4800).fill(3000);
  },
});
const chatSpy = (parts: string[], called: { n: number } = { n: 0 }): ChatBackend => ({
  async *stream() {
    called.n++;
    for (const p of parts) yield p;
  },
});

describe("RobotAssistant: orders typed in the chat", () => {
  it("an order is carried out at once, without calling the LLM, with a spoken 'okay' and the log events", async () => {
    const r = await lobbyRobot();
    const called = { n: 0 };
    const calls: string[] = [];
    const a = new RobotAssistant(r, { chat: chatSpy(["x"], called), tts: toneTts(calls) });
    const events: string[] = [];
    a.on("command", (e) => events.push(`command:${e.actions.map((x) => x.type)}`));
    a.on("action", (e) => events.push(`action:${e.action.type}:${e.result.ok}:${e.source}`));
    const res = await drive(r, a.ask("تقدم للأمام متر"));
    expect(called.n).toBe(0);
    expect(res.commands?.[0].ok).toBe(true);
    expect(r.root.position.z).toBeCloseTo(2.5, 1);
    expect(calls.length).toBe(1); // only the acknowledgement was synthesised
    expect(["حاضر", "تمام", "تم", "أبشر"]).toContain(calls[0]);
    expect(events).toEqual(["command:move", "action:move:true:chat"]);
    expect(a.history.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
  it("a compound order runs in sequence; turning left makes the robot face left", async () => {
    const r = await lobbyRobot();
    const a = new RobotAssistant(r, { chat: chatSpy(["x"]), tts: toneTts() });
    const order: string[] = [];
    a.on("action", (e) => order.push(e.action.type));
    await drive(r, a.ask("استدر يسارا 90 درجة ثم تقدم مترين"), 60);
    expect(order).toEqual(["turn", "move"]);
    expect(yawDeg(r)).toBeCloseTo(90, -1);
    expect(r.root.position.x).toBeGreaterThan(1.8);
  });
  it("tells the user, aloud, when something is in the way", async () => {
    const r = await lobbyRobot();
    r.root.position.set(0, 0, 4.5);
    const calls: string[] = [];
    const a = new RobotAssistant(r, { chat: chatSpy(["x"]), tts: toneTts(calls) });
    const res = await drive(r, a.ask("تقدم 20 متر"), 80);
    expect(res.commands?.[0].ok).toBe(false);
    expect(calls.length).toBe(2); // "okay" + the explanation
    expect(calls[1]).toMatch(/عائق|أصل|أستطيع/);
  });
  it("a question that is not an order still goes to the LLM; commands:false and the option also skip the parser", async () => {
    const r = await lobbyRobot();
    const called = { n: 0 };
    const a = new RobotAssistant(r, { chat: chatSpy(["Hello there my friend. "], called), tts: toneTts() });
    await drive(r, a.ask("ما هي الكليات المتوفرة في الجامعة؟"));
    expect(called.n).toBe(1);
    await drive(r, a.ask("تقدم للأمام", { commands: false }));
    expect(called.n).toBe(2);
    const off = new RobotAssistant(r, { chat: chatSpy(["Hi. "], called), tts: toneTts(), commands: false });
    await drive(r, off.ask("تقدم للأمام"));
    expect(called.n).toBe(3);
  });
  it("'stop' cancels a walk in progress; cancel() also stops a walk", async () => {
    const r = await lobbyRobot();
    const a = new RobotAssistant(r, { chat: chatSpy(["x"]), tts: toneTts() });
    const p = a.ask("تقدم 5 متر");
    for (let i = 0; i < 90; i++) r.update(1 / 60);
    const z = r.root.position.z;
    expect(z).toBeGreaterThan(1.6);
    const s = a.ask("قف");
    const res = await drive(r, s, 10);
    expect(res.commands?.[0].action.type).toBe("stop");
    const first = await drive(r, p, 10);
    expect(first.aborted).toBe(true);
    expect(r.root.position.z).toBeLessThan(z + 0.8); // it did not go on to 6.5
  });
  it("silent mode (voice:false) does not call TTS but still returns the text", async () => {
    const r = await lobbyRobot();
    const calls: string[] = [];
    const a = new RobotAssistant(r, { chat: chatSpy(["x"]), tts: toneTts(calls), commands: { voice: false } });
    const res = await drive(r, a.ask("turn left"));
    expect(calls).toEqual([]);
    expect(res.text.length).toBeGreaterThan(0);
    expect(yawDeg(r)).toBeCloseTo(90, -1);
  });
});

describe("RobotAssistant: [action=...] tags from the LLM", () => {
  it("runs the action when its sentence is spoken and finishes it before the answer is done; unknown tags are ignored", async () => {
    const r = await lobbyRobot();
    const a = new RobotAssistant(r, { chat: chatSpy(["[action=goto:desk]Please follow me to the reception desk. [action=fly]It is just here."]), tts: toneTts() });
    const acts: string[] = [];
    a.on("action", (e) => acts.push(`${e.action.type}:${e.result.ok}:${e.source}`));
    const res = await drive(r, a.ask("Where is the reception desk?"), 80);
    expect(acts).toEqual(["goto:true:llm"]);
    expect(res.text).toContain("reception desk");
    expect(res.text).not.toContain("action");
    expect(Math.hypot(r.root.position.x - LOBBY_PLACES.desk.x, r.root.position.z - LOBBY_PLACES.desk.z)).toBeLessThan(0.3);
  });
});
