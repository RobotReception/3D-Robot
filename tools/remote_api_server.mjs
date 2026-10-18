// Reference REMOTE API for the robot: HTTP (for your backend / AI agent) <-> WebSocket (the browser page running the robot).
//
//   API_KEY=secret PORT=8787 node tools/remote_api_server.mjs
//   robot page: Studio -> Developer -> WebSocket -> ws://localhost:8787 -> Connect   (or connectWebSocket(robot, url))
//
//   POST /v1/command          body: one command object or an array         -> the robot's reply
//   GET  /v1/status                                                         -> robot status
//   GET  /v1/motions          list custom + built-in animation names
//   GET  /v1/motions/:name    motion as JSON (built-ins are sampled)
//   POST /v1/motions?play=1   body: a motion JSON                           -> {ok, warnings} or 400 with precise errors
//   GET  /v1/schema/motion    JSON Schema to give an LLM
//   GET  /v1/health
// Optional: ?robot=<index> picks one of several connected robots; ?timeout=<ms> (default 30000).
import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = +(process.env.PORT || 8787);
const API_KEY = process.env.API_KEY || "";
const robots = new Set();
const pending = new Map(); // id -> {resolve, timer}
let seq = 1;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { ok: false, error: "unauthorized" });
  if (url.pathname === "/v1/health") return send(200, { ok: true, robots: robots.size });

  const read = () => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
  const ask = (cmd) => new Promise((resolve) => {
    const list = [...robots];
    const robot = list[+(url.searchParams.get("robot") || 0)];
    if (!robot) return resolve({ ok: false, error: "no robot connected" });
    const id = cmd.id ?? `r${seq++}`;
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, id, error: "timeout waiting for the robot" }); }, +(url.searchParams.get("timeout") || 30000));
    pending.set(id, { resolve, timer });
    robot.send(JSON.stringify({ ...cmd, id }));
  });
  const reply = async (cmd, okCode = 200) => { const r = await ask(cmd); send(r.ok ? okCode : r.error === "no robot connected" ? 503 : 400, r); };

  try {
    if (req.method === "POST" && url.pathname === "/v1/command") {
      const body = JSON.parse((await read()) || "null");
      if (Array.isArray(body)) return send(200, { ok: true, results: await Promise.all(body.map(ask)) });
      return reply(body);
    }
    if (req.method === "GET" && url.pathname === "/v1/status") return reply({ cmd: "getStatus" });
    if (req.method === "GET" && url.pathname === "/v1/motions") return reply({ cmd: "listMotions" });
    if (req.method === "GET" && url.pathname.startsWith("/v1/motions/")) return reply({ cmd: "getMotion", name: decodeURIComponent(url.pathname.slice(12)) });
    if (req.method === "GET" && url.pathname === "/v1/schema/motion") return reply({ cmd: "getMotionSchema" });
    if (req.method === "POST" && url.pathname === "/v1/motions") {
      const motion = JSON.parse((await read()) || "null");
      return reply({ cmd: "registerMotion", motion, play: url.searchParams.get("play") === "1", overwrite: url.searchParams.get("overwrite") === "1" }, 201);
    }
    send(404, { ok: false, error: "not found" });
  } catch (e) {
    send(400, { ok: false, error: `bad request: ${e.message}` });
  }
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  robots.add(ws);
  ws.on("close", () => robots.delete(ws));
  ws.on("message", (m) => {
    let msg; try { msg = JSON.parse(String(m)); } catch { return; }
    if (msg.event) return; // events could be forwarded to subscribers (SSE/WebSocket) here
    const p = msg.id !== undefined && pending.get(msg.id);
    if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg); }
  });
});
server.listen(PORT, () => console.log(`robot remote API on http://localhost:${PORT}  (robots connect to ws://localhost:${PORT})`));
