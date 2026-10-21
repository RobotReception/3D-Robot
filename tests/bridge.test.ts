import { afterEach, describe, expect, it, vi } from "vitest";
import { attachBridge, connectWebSocket } from "../src/engine/bridge";
import { makeRobot } from "./helpers/robot";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bridge lifecycle", () => {
  it("ignores incoming commands after detach, including legacy transports", async () => {
    const robot = await makeRobot();
    let receive!: (data: string) => void;
    const send = vi.fn();
    const detach = attachBridge(robot, { send, onMessage: (cb) => { receive = cb; } });
    detach();
    receive(JSON.stringify({ cmd: "setEmotion", emotion: "sad" }));
    await Promise.resolve();
    expect(robot.face.emotion.name).not.toBe("sad");
    expect(send).not.toHaveBeenCalled();
    robot.dispose();
  });

  it("cancels a pending reconnect when closed", async () => {
    const robot = await makeRobot();
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      onclose: (() => void) | null = null;
      onopen: (() => void) | null = null;
      onmessage = null;
      onerror = null;
      close() { this.onclose?.(); }
      constructor() { sockets.push(this); }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const connection = connectWebSocket(robot, "ws://localhost");
    sockets[0].onclose?.();
    connection.close();
    await vi.advanceTimersByTimeAsync(20000);
    expect(sockets).toHaveLength(1);
    robot.dispose();
  });
});
