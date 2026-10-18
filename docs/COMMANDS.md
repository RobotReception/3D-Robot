# JSON command protocol & WebSocket bridge

Every command is a JSON object with a string `cmd`; an optional `id` is echoed in the reply. Commands are validated (types, enums) and **never throw**: failures return `{ok:false,error}`.
Implemented in `src/engine/commands.ts`; tested in `tests/api.test.ts` and the browser E2E (`WebSocket bridge`).

```jsonc
{ "id": 1, "cmd": "playAnimation", "name": "greeting", "speed": 1, "wait": true }
{ "cmd": "setEmotion", "emotion": "happy", "intensity": 0.8 }
{ "cmd": "setEyeExpression", "expression": "curious" }          // null to release
{ "cmd": "lookAt", "target": { "x": 0, "y": 1.4, "z": 2 } }     // null to release
{ "cmd": "moveHead", "yaw": 20, "pitch": 10, "roll": 0, "hold": 3 }
{ "cmd": "moveArm", "side": "right", "shoulder": 30, "elbow": 45, "wrist": 10 }
{ "cmd": "moveTorso", "yaw": 20, "pitch": 10 }
{ "cmd": "setEyeDirection", "yaw": 15, "pitch": 5, "eye": "left" }   // eye: both|left|right; "release": true to follow lookAt
{ "cmd": "moveJoint", "bone": "spine", "y": 15 }   { "cmd": "releaseJoint", "bone": "spine" }
{ "cmd": "setHand", "side": "left", "pose": "fist" }            // or "curl": {"index":1,"middle":0}
{ "cmd": "pointAt", "target": { "x": 1, "y": 1.3, "z": 1 }, "hand": "auto", "hold": 3 }
{ "cmd": "setMouthOpen", "value": 0.5 }   { "cmd": "blink" }   { "cmd": "blink", "eye": "left" }   // wink
{ "cmd": "walkTo", "x": 2, "z": 3, "speed": 0.8, "facing": 180, "wait": true }
{ "cmd": "turn", "degrees": 90 }   { "cmd": "turn", "to": 180 }
{ "cmd": "speak", "text": "Hello", "lang": "en-US", "emotion": "friendly", "visemes": [ ... ], "wait": true }
{ "cmd": "setState", "state": "thinking" }
{ "cmd": "setSpeed", "value": 1.5 }   { "cmd": "setGlow", "color": "#59d0ff", "boost": 0.5 }
{ "cmd": "stop" }   { "cmd": "resetPose", "position": true }   { "cmd": "getStatus" }
{ "cmd": "registerMotion", "motion": { … see MOTION_AUTHORING.md … }, "overwrite": false, "play": true }
{ "cmd": "listMotions" }   { "cmd": "getMotion", "name": "greeting" }   { "cmd": "getMotionSchema" }
{ "cmd": "wait", "seconds": 0.5 }
{ "cmd": "sequence", "steps": [ ... ] }    // sequential; walkTo/turn/speak/playAnimation wait for completion
{ "cmd": "parallel", "steps": [ ... ] }
[ {…}, {…} ]                                // an array runs the commands in order
```

Reply: `{"ok":true,"id":1,"cmd":"playAnimation","result":{"accepted":["armR",…],"rejected":[]}}` or `{"ok":false,"id":1,"error":"\"emotion\" must be one of: …"}`.

## WebSocket

```ts
import { connectWebSocket, attachBridge } from "./src";
const link = connectWebSocket(robot, "wss://your-backend/robot");   // reconnects with exponential back-off
// custom transport (postMessage, WebRTC data channel, in-memory...):
attachBridge(robot, { send: (s) => port.postMessage(s), onMessage: (cb) => port.addEventListener("message", e => cb(e.data)) });
```

- Server → robot: command frames (text JSON).
- Robot → server: one reply per command, plus event frames `{"event":"state","data":{"from":"idle","to":"listening"}}` for `animation:*`, `emotion`, `state`, `speech:*`, `walk:*`, `error`.
- **Security:** the bridge executes whatever the server sends; connect only to backends you trust and use `wss://`. The engine does not authenticate peers.
- Demo server: `npm run ws:example` (scripted assistant turn), then Studio → Developer → Connect.
- HTTP façade for backends/AI agents (`npm run api:server`): [REMOTE_API.md](REMOTE_API.md).

## LLM tool-calling

The command set doubles as a tool schema: expose `{cmd, ...}` as one function `robot_command(command: object)` and forward the model's JSON to `executeCommand(robot, json)`; errors are returned as text the model can read and correct.
