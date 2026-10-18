// Minimal example "AI backend": drives the robot over WebSocket with JSON commands.
//   node tools/ws_example_server.mjs     then open the Studio -> Developer -> WebSocket -> Connect (ws://localhost:8787)
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8787 });
console.log("listening on ws://localhost:8787");
wss.on("connection", (ws) => {
  const send = (cmd) => ws.send(JSON.stringify(cmd));
  ws.on("message", (m) => {
    const msg = JSON.parse(String(m));
    if (msg.event) console.log("event", msg.event, JSON.stringify(msg.data));
    else console.log("reply", JSON.stringify(msg));
  });
  // a scripted "assistant turn": listen -> think -> answer with emotion, gestures and a pointing hand
  send({ id: 1, cmd: "setState", state: "listening" });
  setTimeout(() => send({ id: 2, cmd: "setState", state: "thinking" }), 2000);
  setTimeout(() => send({
    id: 3, cmd: "sequence", steps: [
      { cmd: "setState", state: "idle" },
      { cmd: "speak", text: "I found it! Look over there.", emotion: "happy", tts: false },
      { cmd: "pointAt", target: { x: 1.2, y: 1.3, z: 1.2 }, hand: "left", hold: 2.5 },
    ],
  }), 4500);
});
