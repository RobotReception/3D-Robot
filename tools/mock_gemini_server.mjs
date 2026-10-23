// A tiny stand-in for the Gemini REST API (same wire format as generateContent / streamGenerateContent?alt=sse), used by
// the end-to-end tests and for trying examples/gemini without a key:
//   node tools/mock_gemini_server.mjs [port]      then run the proxy with GEMINI_BASE_URL=http://localhost:8799 GEMINI_API_KEY=test-key
import http from "node:http";

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 8799);
const KEY = process.env.MOCK_KEY ?? "test-key";
export const requests = [];

const REPLIES = {
  ar: "[gesture=greeting]أهلاً بك في جامعة الرازي. [emotion=curious]كيف أستطيع مساعدتك اليوم؟ يسعدني أن أجيب عن أسئلتك حول القبول والتخصصات.",
  en: "[gesture=greeting]Welcome to Al-Razi University. [emotion=curious]How can I help you today? I am happy to answer questions about admissions and programs!",
  guide: "[action=goto:desk]Of course, please follow me to the reception desk. [gesture=pointing]It is right here, our staff will help you.",
  slow: "This is a long answer that keeps going so that it can be interrupted by the user. It has many sentences. Here is another sentence. And another one. And one more to be sure.",
};
const pick = (text) => (/slow|long/i.test(text) ? "slow" : /show me the way/i.test(text) ? "guide" : /[ء-ي]/.test(text) ? "ar" : "en");

function tone(text, rate = 24000) {
  const n = Math.max(2400, Math.round(text.length * 0.055 * rate)); // ~18 chars per second
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const syl = Math.sin((i / rate) * Math.PI * 7) ** 2; // syllable-like bursts
    b.writeInt16LE(Math.round(9000 * syl * Math.sin(i * 0.17)), i * 2);
  }
  return b;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  requests.push({ path: url.pathname, body, key: req.headers["x-goog-api-key"] });
  const err = (code, message, status = "ERROR") => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code, message, status } }));
  };
  if (req.headers["x-goog-api-key"] !== KEY) return err(403, "API key not valid. Please pass a valid API key.", "PERMISSION_DENIED");
  const m = /^\/v1beta\/models\/([^:]+):(streamGenerateContent|generateContent)$/.exec(url.pathname);
  if (!m) return err(404, "not found");
  const [, model, method] = m;
  if (model === "bad-model") return err(404, `models/${model} is not found for API version v1beta`, "NOT_FOUND");
  if (model === "quota-model") return err(429, "You exceeded your current quota.", "RESOURCE_EXHAUSTED");

  if (method === "streamGenerateContent") {
    const last = body.contents?.at(-1)?.parts?.map((p) => p.text).join(" ") ?? "";
    const reply = REPLIES[pick(last)];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const step = 6;
    for (let i = 0; i < reply.length; i += step) {
      const part = { candidates: [{ content: { role: "model", parts: [{ text: reply.slice(i, i + step) }] }, index: 0 }] };
      res.write(`data: ${JSON.stringify(part)}\r\n\r\n`);
      await new Promise((r) => setTimeout(r, 12));
      if (res.destroyed) return;
    }
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP", index: 0 }] })}\r\n\r\n`);
    return res.end();
  }
  // TTS
  const text = body.contents?.[0]?.parts?.[0]?.text ?? "";
  if (body.generationConfig?.responseModalities?.[0] !== "AUDIO") return err(400, "this mock only serves AUDIO on generateContent");
  const pcm = tone(text);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }] }));
});
server.listen(port, () => console.log(`mock Gemini on http://localhost:${port} (key "${KEY}")`));
