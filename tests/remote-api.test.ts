import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

let server: ChildProcess;
let base: string;
const sockets: WebSocket[] = [];
const headers = { authorization: "Bearer test-key", "content-type": "application/json" };
const api = (body: unknown, query = "") => fetch(`${base}/v1/command${query}`, { method: "POST", headers, body: JSON.stringify(body) });
async function connect() {
  const ws = new WebSocket(base.replace("http:", "ws:"), [`robot-auth.${Buffer.from("test-key").toString("base64url")}`]);
  sockets.push(ws);
  await once(ws, "open");
  return ws;
}
beforeAll(async () => {
  server = spawn(process.execPath, ["tools/remote_api_server.mjs"], { env: { ...process.env, PORT: "0", API_KEY: "test-key" }, stdio: ["ignore", "pipe", "pipe"] });
  base = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", () => reject(new Error("API server exited before startup")));
    server.stdout!.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
      if (match) resolve(`http://localhost:${match[1]}`);
    });
  });
});
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
});

describe("remote API isolation and validation", () => {
  it("requires authentication for HTTP and WebSocket", async () => {
    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    const ws = new WebSocket(base.replace("http:", "ws:"));
    const error = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(error.message).toContain("401");
    ws.terminate();
  });
  it("isolates replies by robot and preserves duplicate client ids", async () => {
    const robot = await connect();
    const other = await connect();
    robot.on("message", (data) => {
      const cmd = JSON.parse(String(data));
      other.send(JSON.stringify({ id: cmd.id, ok: true, result: "forged" }));
      setTimeout(() => robot.send(JSON.stringify({ id: cmd.id, ok: true, result: cmd.cmd })), 20);
    });
    const response = await api([{ id: "same", cmd: "one" }, { id: "same", cmd: "two" }]);
    const body = await response.json();
    expect(body.results.map((r: { result: string }) => r.result)).toEqual(["one", "two"]);
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(["same", "same"]);
    robot.close(); other.close();
    await Promise.all([once(robot, "close"), once(other, "close")]);
  });
  it("settles pending requests immediately when the robot disconnects", async () => {
    const robot = await connect();
    robot.once("message", () => robot.close());
    const response = await api({ cmd: "getStatus" });
    expect((await response.json()).error).toBe("robot disconnected");
  });
  it("rejects oversized bodies, invalid commands and invalid timeouts", async () => {
    expect((await api({ cmd: "x", text: "x".repeat(1024 * 1024) })).status).toBe(413);
    expect((await api(null)).status).toBe(400);
    expect((await api({ cmd: "x" }, "?timeout=-1")).status).toBe(400);
    const batch = await (await api([null])).json();
    expect(batch.ok).toBe(false);
  });
});
