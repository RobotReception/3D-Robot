# Integration guide

## 1. Plain three.js / any framework

```ts
import { RobotAvatar } from "./src";
const robot = await RobotAvatar.load("/models/robot_premium.glb");
scene.add(robot.root);
renderer.setAnimationLoop(() => { robot.update(clock.getDelta()); renderer.render(scene, camera); });
```
`RobotAvatar` owns no DOM and no renderer. `RobotViewer` is an optional ready-made scene (lights, PBR environment, floor, orbit camera, quality tiers, resize, disposal). Full example: [examples/minimal.html](../examples/minimal.html).

## 2. React Three Fiber

```tsx
import { Canvas } from "@react-three/fiber";
import { Robot } from "./src/adapters/r3f";
<Canvas><ambientLight /><Robot url="/models/robot_premium.glb" onReady={(r) => r.playAnimation("greeting")} /></Canvas>
```
Tested in [examples/r3f](../examples/r3f/main.tsx) (React 19 + @react-three/fiber 9). The adapter advances the robot from `useFrame` and disposes it on unmount.

## 3. Wiring an AI assistant

```ts
// conversation events from your backend
onUserSpeechStart(() => robot.setState("listening"));
onUserSpeechEnd(()   => robot.setState("thinking"));
onAssistantReply(async ({ text, audioUrl, visemes, emotion }) => {
  await robot.speak({ text, audioUrl, visemes, emotion }).finished;   // speaking state + gestures are automatic
});
onToolError(() => robot.setState("error"));
robot.stateMachine.userTarget = camera;      // eyes on the user
```
Remote backends can instead send JSON commands over WebSocket ([COMMANDS.md](COMMANDS.md)); an LLM can emit them directly as tool calls.

## 4. Replacing the character

Any GLB that has the 40 bones and 43 morph targets of [RIG.md](RIG.md) works (the loader lists what is missing). Leg/arm lengths are measured from the rest pose, so proportions may differ; bones must hang straight in the rest pose (arms/legs along −Y, legs straight) because the IK uses the rest directions. Texture/materials are free; `Mat_Glow`/`Mat_Face` are optional (glow helpers are skipped if absent).

## 5. Loading options

- Meshopt-compressed GLBs load out of the box. Draco: `RobotAvatar.load(url, { dracoPath: "/draco/" })` (decoder fetched lazily; **this path is implemented but was not exercised by a test**, only Meshopt was). KTX2 textures are not needed by the shipped models; add `KTX2Loader` to `loader.ts` if you add textures.
- Serve `.glb` with `application/octet-stream` or `model/gltf-binary` and gzip/brotli is optional (already compressed).

## 6. Deployment checklist

`npm run build` → `dist/` is static. Audio needs a user gesture before the first sound (Studio buttons satisfy this). Use `https` for WebSocket (`wss`). Pick the quality tier from device capability (`RobotViewer.setQuality("low")` on weak phones).
