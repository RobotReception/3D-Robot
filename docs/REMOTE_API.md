# Controlling the robot from outside (your own API)

The robot runs **in a browser page** (three.js, WebGL). Your backend or AI agent therefore talks to it over a channel the page opens. Two layers are provided:

```
 your backend / AI agent ──HTTP──► remote API server (tools/remote_api_server.mjs) ──WebSocket──► page with the robot
        ◄──────────── JSON reply ◄──────────────────────────────────────────────── ◄── result / events
```

- **WebSocket protocol** (engine, `src/engine/bridge.ts`): server → robot JSON commands ([COMMANDS.md](COMMANDS.md)); robot → server replies `{ok,id,…}` and events.
- **HTTP façade** (`tools/remote_api_server.mjs`, ~100 lines, depends only on `ws`): a reference implementation you can run as is or port to Express/FastAPI/Go. It is covered by a browser E2E test (register a motion over HTTP and see the robot play it).

```bash
API_KEY=secret PORT=8787 npm run api:server
# on the robot page: Studio → Developer → WebSocket → ws://localhost:8787 → Connect
#   Enter secret in the Studio's WebSocket API key field.
#   or: connectWebSocket(robot, "ws://localhost:8787", { apiKey: "secret" })
```

## Endpoints

| Method & path | Body | Result |
|---|---|---|
| `GET /v1/health` | – | `{ok, robots}` (number of connected robot pages) |
| `POST /v1/command` | one [command](COMMANDS.md) or an array | the robot's reply `{ok,id,cmd,result}`; arrays → `{ok,results:[…]}` (run concurrently; use `sequence` for order) |
| `GET /v1/status` | – | `getStatus()` (state, emotion, animations per channel, gaze, locomotion, lip-sync…) |
| `GET /v1/motions` | – | `{custom:[…], all:[…]}` animation names |
| `GET /v1/motions/:name` | – | motion JSON (custom as submitted; built-ins sampled) |
| `POST /v1/motions?play=1&overwrite=1` | motion JSON | `201 {ok,result:{name,warnings,played}}` or `400 {ok:false,error:"invalid motion: keys[1].armR.elbow: …"}` |
| `GET /v1/schema/motion` | – | JSON Schema of a motion (give it to the LLM) |

Query options: `?robot=<index>` (non-negative integer), `?timeout=<ms>` (1–120000, default 30000; commands with `"wait":true` reply when finished).

HTTP bodies and WebSocket messages are limited to 1 MiB; batches to 100 commands and outstanding requests to 1024. Oversized HTTP bodies return 413. Batch `ok` is false if any command fails. Requests use unique internal IDs and only accept replies from the selected robot; the original client ID is preserved. Robot disconnection settles its pending requests immediately.

When `API_KEY` is set, WebSocket upgrades require authentication too. Browser clients use `connectWebSocket(..., { apiKey })`, which sends a `robot-auth.<base64url-encoded UTF-8 key>` subprotocol. Non-browser clients may instead send the same Bearer header as HTTP. Use TLS (`wss://`) outside local development; encoding the key does not encrypt it. The Studio keeps the key only in component memory.
Errors: `401` bad/missing `Authorization: Bearer <API_KEY>`, `503 no robot connected`, `400` invalid command/motion (message says why), `404`.

## Examples

```bash
H='Authorization: Bearer secret'
curl -H "$H" localhost:8787/v1/status
curl -H "$H" -XPOST localhost:8787/v1/command -d '{"cmd":"playAnimation","name":"greeting"}'
curl -H "$H" -XPOST localhost:8787/v1/command -d '{"cmd":"moveHead","yaw":25,"pitch":10}'
curl -H "$H" -XPOST localhost:8787/v1/command -d '{"cmd":"speak","text":"مرحبا، كيف أساعدك؟","emotion":"friendly","wait":true}'
curl -H "$H" -XPOST localhost:8787/v1/command -d '{"cmd":"sequence","steps":[
  {"cmd":"walkTo","x":1.5,"z":2,"facing":180},{"cmd":"pointAt","target":{"x":-1,"y":1.3,"z":1}},{"cmd":"setEmotion","emotion":"happy"}]}'
curl -H "$H" -XPOST 'localhost:8787/v1/motions?play=1' -d @my_motion.json
```

All of the above are the same commands as in [COMMANDS.md](COMMANDS.md) (animations, emotions, gaze, head/arm/torso/finger control, IK pointing, walking, speech, state machine, JSON motions).

## Building your own API instead

1. In the page: `connectWebSocket(robot, url)` (reconnecting) or `attachBridge(robot, transport)` for any transport (postMessage, WebRTC data channel, SSE+fetch…).
2. In your server: send `{"id": "...", "cmd": …}` frames, match replies by `id`; treat frames with `"event"` as notifications (`speech:end`, `walk:end`, `state`, …) — e.g. to know when to send the next sentence.
3. Wrap it in whatever REST/gRPC/GraphQL surface you need. Authenticate in *your* layer (the engine does not authenticate peers).

## For an LLM agent (tool calling)

Expose one tool, `robot_command(command: object)`, whose description lists [COMMANDS.md](COMMANDS.md), and one tool `robot_register_motion(motion: object)` whose parameter schema is `GET /v1/schema/motion`. Forward the JSON to `POST /v1/command` / `POST /v1/motions` and return the reply text to the model: validation errors contain exact paths so the model can self-correct. Motion authoring tips and a prompt template: [MOTION_AUTHORING.md](MOTION_AUTHORING.md).

## Security & operations

- The robot executes whatever its server sends: use `wss://`, an API key (built in here), network ACLs, and don't expose the server publicly without auth/rate limits.
- Validation protects against malformed or out-of-range data (limits, size caps: ≤ 240 keys, ≤ 30 s), not against an authorised caller spamming commands.
- One page = one robot. The server holds no robot state; if the page reloads, re-register custom motions. This reference server has no persistence, no CORS headers and no event streaming to HTTP clients (events are received but dropped) — add them if needed.
- The robot cannot render without a browser/WebGL context: for server-side video you need a headless Chromium running the page.
