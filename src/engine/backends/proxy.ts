import type { ChatBackend, ChatRequest, TtsBackend } from "../assistant";

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string | { message?: string }; message?: string };
    const e = typeof j.error === "string" ? j.error : j.error?.message ?? j.message;
    return `HTTP ${res.status}: ${e ?? res.statusText}`;
  } catch {
    return `HTTP ${res.status}: ${res.statusText}`;
  }
}

/**
 * Chat through YOUR server (the API key never reaches the browser). Expects the `examples/gemini/server.ts` contract:
 * `POST url {messages, language, system?}` → Server-Sent Events `data: {"text":"..."}` ... `data: [DONE]`
 * (`event: error` + `data: {"message":"..."}` on failure).
 */
export class ProxyChatBackend implements ChatBackend {
  constructor(private o: { url?: string; headers?: Record<string, string>; sendSystem?: boolean } = {}) {}
  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<string> {
    const res = await fetch(this.o.url ?? "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.o.headers },
      body: JSON.stringify({ messages: req.messages, language: req.language, ...(this.o.sendSystem ? { system: req.system } : {}) }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(await errorText(res));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const kind = /^event:\s*(\w+)/m.exec(block)?.[1];
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        const j = JSON.parse(data) as { text?: string; message?: string };
        if (kind === "error") throw new Error(j.message ?? "chat failed");
        if (j.text) yield j.text;
      }
    }
  }
}

/** Speech through YOUR server: `POST url {text, voice?}` → raw signed 16-bit mono PCM (header `X-Sample-Rate`, default 24000). */
export class ProxyTtsBackend implements TtsBackend {
  sampleRate = 24000;
  constructor(private o: { url?: string; voice?: string; headers?: Record<string, string> } = {}) {}
  async synth(text: string, signal: AbortSignal): Promise<Int16Array | null> {
    const res = await fetch(this.o.url ?? "/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.o.headers },
      body: JSON.stringify({ text, voice: this.o.voice }),
      signal,
    });
    if (!res.ok) throw new Error(await errorText(res));
    const sr = Number(res.headers.get("x-sample-rate"));
    if (sr > 0) this.sampleRate = sr;
    const buf = await res.arrayBuffer();
    return buf.byteLength >= 2 ? new Int16Array(buf.slice(0, buf.byteLength & ~1)) : null;
  }
}
