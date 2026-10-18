import { executeMessage } from "./commands";
import type { RobotAvatar } from "./RobotAvatar";

/** Anything that can send/receive text frames (WebSocket, postMessage wrapper, in-memory pair...). */
export interface BridgeTransport {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose?(cb: () => void): void;
  close?(): void;
}

const FORWARDED = ["animation:start", "animation:end", "animation:blocked", "emotion", "state", "speech:start", "speech:end", "walk:start", "walk:end", "error"] as const;

/**
 * Connects a robot to a transport: incoming text frames are JSON commands, replies are
 * `{ok,id,...}` results, and robot events are pushed as `{"event": name, "data": {...}}`.
 * Returns a detach function.
 */
export function attachBridge(robot: RobotAvatar, transport: BridgeTransport, o: { events?: boolean } = {}): () => void {
  transport.onMessage(async (data) => {
    const res = await executeMessage(robot, data);
    transport.send(JSON.stringify(res));
  });
  const offs: (() => void)[] = [];
  if (o.events !== false) {
    for (const ev of FORWARDED) {
      offs.push(robot.on(ev, (d) => transport.send(JSON.stringify({ event: ev, data: d }))));
    }
  }
  return () => offs.forEach((f) => f());
}

/**
 * Browser WebSocket client with exponential-backoff reconnect.
 * A server (your LLM backend) sends JSON commands; the robot answers and streams events.
 */
export function connectWebSocket(robot: RobotAvatar, url: string, o: { reconnect?: boolean; onStatus?: (s: "open" | "closed" | "error") => void } = {}) {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let detach: (() => void) | null = null;
  const open = () => {
    ws = new WebSocket(url);
    const sock = ws;
    sock.onopen = () => {
      attempt = 0;
      o.onStatus?.("open");
      detach = attachBridge(robot, {
        send: (d) => sock.readyState === WebSocket.OPEN && sock.send(d),
        onMessage: (cb) => (sock.onmessage = (e) => cb(String(e.data))),
      });
    };
    sock.onerror = () => o.onStatus?.("error");
    sock.onclose = () => {
      detach?.();
      o.onStatus?.("closed");
      if (!closed && o.reconnect !== false) setTimeout(open, Math.min(10000, 500 * 2 ** attempt++));
    };
  };
  open();
  return {
    close() {
      closed = true;
      detach?.();
      ws?.close();
    },
  };
}
