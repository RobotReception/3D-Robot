/**
 * Gemini proxy for the robot: keeps GEMINI_API_KEY on the server, streams answers as Server-Sent Events and returns
 * speech as raw PCM. Also serves `dist/` (so `npm run build && npm run gemini:server` is the whole production app).
 *
 *   GEMINI_API_KEY=...  npm run gemini:server        (or put the variables in a .env file next to package.json)
 *
 * Endpoints: GET /api/health · POST /api/chat {messages,language} → SSE · POST /api/tts {text,voice?} → PCM16 24 kHz
 * Node >= 20, no dependencies (run through tsx so it can share `buildSystemPrompt` with the browser code).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "../../src/engine/assistantPrompt";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---- minimal .env loader (KEY=value, # comments); real environment variables win
for (const f of [path.join(root, ".env"), path.join(root, ".env.local")]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = (k: string, d = "") => process.env[k] ?? d;
const cfg = {
  port: Number(env("PORT", "8788")),
  key: env("GEMINI_API_KEY"),
  base: env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com").replace(/\/$/, ""),
  model: env("GEMINI_MODEL", "gemini-3.8-flash"),
  ttsModel: env("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts"),
  voice: env("GEMINI_VOICE", "Kore"),
  ttsStyle: env("TTS_STYLE", ""), // e.g. "Say warmly and clearly:" (Gemini TTS follows natural-language style hints)
  temperature: Number(env("GEMINI_TEMPERATURE", "0.7")),
  maxTokens: Number(env("GEMINI_MAX_TOKENS", "500")),
  allowClientSystem: env("ALLOW_CLIENT_SYSTEM") === "1",
  origin: env("ALLOWED_ORIGIN"), // set when the page is served from another origin
  chatPerMin: Number(env("RATE_CHAT_PER_MIN", "30")),
  ttsPerMin: Number(env("RATE_TTS_PER_MIN", "120")),
  staticDir: path.join(root, "dist"),
};
const language = env("ROBOT_LANGUAGE", "auto") as "auto" | "ar" | "en";
const systemPrompt = env("SYSTEM_PROMPT") || buildSystemPrompt({
  name: env("ROBOT_NAME", "Razi"), organization: env("ROBOT_ORG", "Al-Razi University"), role: env("ROBOT_ROLE", "reception assistant"),
  language, extra: env("ROBOT_EXTRA"),
});

// ---- helpers
const json = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
};
const hits = new Map<string, number[]>();
function limited(ip: string, bucket: string, perMin: number) {
  const k = `${bucket}:${ip}`, now = Date.now();
  const list = (hits.get(k) ?? []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(k, list);
  return list.length > perMin;
}
async function readBody(req: http.IncomingMessage, max = 64 * 1024): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error("request too large"), { status: 413 });
    parts.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}
const upstreamError = async (r: Response) => {
  let msg = r.statusText;
  try {
    const j = (await r.json()) as { error?: { message?: string } };
    msg = j.error?.message ?? msg;
  } catch { /* not JSON */ }
  return Object.assign(new Error(msg), { status: r.status });
};
const gemini = (p: string, body: unknown, signal: AbortSignal) =>
  fetch(`${cfg.base}/v1beta/${p}`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": cfg.key }, body: JSON.stringify(body), signal });

type Msg = { role: "user" | "assistant"; text: string };
function validMessages(x: unknown): Msg[] {
  if (!Array.isArray(x) || !x.length || x.length > 40) throw Object.assign(new Error("messages must be a non-empty array (max 40)"), { status: 400 });
  const out: Msg[] = [];
  for (const m of x as Msg[]) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string" || !m.text.trim() || m.text.length > 3000) {
      throw Object.assign(new Error("each message needs role user|assistant and text (max 3000 chars)"), { status: 400 });
    }
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.text += "\n" + m.text; // Gemini wants alternating turns
    else out.push({ role: m.role, text: m.text });
  }
  if (out[0].role !== "user") out.shift();
  if (out.at(-1)?.role !== "user") throw Object.assign(new Error("the last message must be from the user"), { status: 400 });
  return out;
}

// ---- POST /api/chat : Gemini streamGenerateContent -> SSE {text}
async function chat(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = (await readBody(req)) as { messages?: unknown; system?: string; language?: string };
  const messages = validMessages(body.messages);
  const system = cfg.allowClientSystem && typeof body.system === "string" && body.system.trim() ? body.system : systemPrompt;
  const ctl = new AbortController();
  res.on("close", () => ctl.abort()); // the user interrupted / left: stop paying for tokens
  const up = await gemini(`models/${cfg.model}:streamGenerateContent?alt=sse`, {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] })),
    generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.maxTokens },
  }, ctl.signal);
  if (!up.ok || !up.body) throw await upstreamError(up);
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  const send = (event: string | null, data: unknown) => res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  const reader = up.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let blocked: string | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      const j = JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
      if (j.promptFeedback?.blockReason) blocked = j.promptFeedback.blockReason;
      const cand = j.candidates?.[0];
      for (const p of cand?.content?.parts ?? []) if (p.text && !p.thought) send(null, { text: p.text });
      if (cand?.finishReason === "SAFETY" || cand?.finishReason === "PROHIBITED_CONTENT") blocked = cand.finishReason;
    }
  }
  if (blocked) send("error", { message: `The answer was blocked by the safety filter (${blocked}).` });
  send(null, "[DONE]");
  res.end();
}

// ---- POST /api/tts : Gemini TTS (generateContent, AUDIO) -> raw PCM16 mono
async function tts(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = (await readBody(req)) as { text?: string; voice?: string };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 1200) throw Object.assign(new Error("text is required (max 1200 chars)"), { status: 400 });
  const voice = typeof body.voice === "string" && /^[A-Za-z]{3,20}$/.test(body.voice) ? body.voice : cfg.voice;
  const ctl = new AbortController();
  res.on("close", () => ctl.abort());
  const up = await gemini(`models/${cfg.ttsModel}:generateContent`, {
    contents: [{ parts: [{ text: cfg.ttsStyle ? `${cfg.ttsStyle} ${text}` : text }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  }, ctl.signal);
  if (!up.ok) throw await upstreamError(up);
  const j = (await up.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
  const inline = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw Object.assign(new Error("TTS returned no audio"), { status: 502 });
  const rate = /rate=(\d+)/.exec(inline.mimeType ?? "")?.[1] ?? "24000";
  const pcm = Buffer.from(inline.data, "base64");
  res.writeHead(200, { "content-type": "application/octet-stream", "x-sample-rate": rate, "cache-control": "no-store", "access-control-expose-headers": "x-sample-rate" });
  res.end(pcm);
}

// ---- static files (production)
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".wav": "audio/wav", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  let rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(cfg.staticDir, rel));
  if (!file.startsWith(cfg.staticDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found (run `npm run build` to create dist/, or use `npm run dev` with this server as the API)");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const ip = String(req.socket.remoteAddress);
  if (cfg.origin) res.setHeader("access-control-allow-origin", cfg.origin);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-methods": "POST, GET", "access-control-allow-headers": "content-type", "access-control-allow-origin": cfg.origin || "" });
    return res.end();
  }
  const url = (req.url ?? "").split("?")[0];
  try {
    if (url === "/api/health") return json(res, 200, { ok: true, hasKey: !!cfg.key, model: cfg.model, tts: cfg.ttsModel, voice: cfg.voice });
    if (url.startsWith("/api/")) {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      if (!cfg.key) return json(res, 500, { error: "GEMINI_API_KEY is not set on the server (create .env, see docs/GEMINI.md)" });
      if (url === "/api/chat") {
        if (limited(ip, "chat", cfg.chatPerMin)) return json(res, 429, { error: "Too many questions, wait a moment" }, { "retry-after": "10" });
        return await chat(req, res);
      }
      if (url === "/api/tts") {
        if (limited(ip, "tts", cfg.ttsPerMin)) return json(res, 429, { error: "Too many speech requests, wait a moment" }, { "retry-after": "10" });
        return await tts(req, res);
      }
      return json(res, 404, { error: "unknown endpoint" });
    }
    return serveStatic(req, res);
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err.name === "AbortError" ? 499 : err.status && err.status >= 400 ? err.status : 502;
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      return res.end();
    }
    if (err.name !== "AbortError") console.error(`[gemini-proxy] ${req.method} ${url}: ${status} ${err.message}`); // never logs the key
    return json(res, status === 499 ? 400 : status, { error: err.message });
  }
});
server.listen(cfg.port, () => {
  console.log(`Gemini proxy on http://localhost:${cfg.port}  model=${cfg.model}  tts=${cfg.ttsModel}/${cfg.voice}  key=${cfg.key ? "set" : "MISSING (set GEMINI_API_KEY)"}`);
});
