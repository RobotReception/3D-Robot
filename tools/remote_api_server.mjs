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
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

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

  const read = () => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error("body exceeds 1 MiB"), { status: 413 }));
        chunks.length = 0;
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted")));
  });
  const ask = (cmd) => new Promise((resolve) => {
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd) || typeof cmd.cmd !== "string") return resolve({ ok: false, error: "command must be an object with a string cmd" });
    if (cmd.id !== undefined && typeof cmd.id !== "string" && typeof cmd.id !== "number") return resolve({ ok: false, error: "id must be a string or number" });
    const index = Number(url.searchParams.get("robot") ?? 0);
    const timeout = Number(url.searchParams.get("timeout") ?? 30000);
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(timeout) || timeout < 1 || timeout > 120000) return resolve({ ok: false, error: "invalid robot index or timeout (1..120000 ms)" });
    const list = [...robots];
    const robot = list[index];
    if (!robot || robot.readyState !== WebSocket.OPEN) return resolve({ ok: false, error: "no robot connected" });
    if (pending.size >= 1024) return resolve({ ok: false, error: "too many pending commands" });
    const id = randomUUID();
    const clientId = cmd.id ?? `r${seq++}`;
    const finish = (result) => {
      const p = pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(id);
      resolve({ ...result, id: clientId });
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout waiting for the robot" }), timeout);
    pending.set(id, { finish, timer, robot });
    robot.send(JSON.stringify({ ...cmd, id }), (error) => {
      if (error) finish({ ok: false, error: "robot disconnected" });
    });
  });
  const reply = async (cmd, okCode = 200) => { const r = await ask(cmd); send(r.ok ? okCode : r.error === "no robot connected" ? 503 : 400, r); };

  try {
    if (req.method === "POST" && url.pathname === "/v1/command") {
      const body = JSON.parse((await read()) || "null");
      if (Array.isArray(body)) {
        if (body.length > 100) return send(400, { ok: false, error: "batch exceeds 100 commands" });
        const results = await Promise.all(body.map(ask));
        return send(200, { ok: results.every((r) => r.ok), results });
      }
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
    send(e.status || 400, { ok: false, error: `bad request: ${e.message}` });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  // Browsers cannot set Authorization headers: use the standard subprotocol header.
  const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((p) => p.trim());
  const token = protocols.find((p) => p.startsWith("robot-auth."))?.slice(11);
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}` && token !== Buffer.from(API_KEY).toString("base64url")) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  robots.add(ws);
  const disconnect = () => {
    robots.delete(ws);
    for (const p of pending.values()) if (p.robot === ws) p.finish({ ok: false, error: "robot disconnected" });
  };
  ws.on("close", disconnect);
  ws.on("error", disconnect);
  ws.on("message", (m) => {
    let msg; try { msg = JSON.parse(String(m)); } catch { return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.event || typeof msg.ok !== "boolean") return;
    const p = msg.id !== undefined && pending.get(msg.id);
    if (p && p.robot === ws) p.finish(msg);
  });
});
server.listen(PORT, () => console.log(`robot remote API on http://localhost:${server.address().port}  (robots connect to ws://localhost:${server.address().port})`));
