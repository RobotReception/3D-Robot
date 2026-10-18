# Robot API

`RobotAvatar` (`src/engine/RobotAvatar.ts`) is the single facade. All angles are **degrees**, distances **meters**, world axes are three.js (Y up). The robot starts at the origin facing **+Z**.
Everything listed here moves real bones/morph targets and is covered by `tests/api.test.ts` unless noted.

```ts
const robot = await RobotAvatar.load("/models/robot_premium.glb");   // validates bones + morphs
scene.add(robot.root);                                               // or viewer.add(robot)
// each frame:  robot.update(dt)                                     // RobotViewer does this for you
```

## Animations & states

| Call | Behaviour |
|---|---|
| `playAnimation(name, opts?)` → `AnimationHandle` | Plays a clip (`greeting`, `happy`, `sad`, `surprised`, `error`, `goodbye`, `pointing`, `thinking`, `listening`, `nod`, `shake`, `bow`) or `"walking"` (continuous forward) / `"turning"` (+90°). `opts`: `speed`, `priority`, `loop`, `fadeIn`, `fadeOut`, `channels`, `force`, `emotion: false` (don't set the accompanying emotion). Returns `{accepted, rejected, finished: Promise}`. Throws `Unknown animation` with the valid list. |
| `stopAnimation(name?)` | Fade out one clip, or everything above the idle base. |
| `listAnimations()` | Names. |
| `setSpeed(multiplier)` | Global playback speed. |
| `setState("idle"\|"listening"\|"thinking"\|"speaking"\|"error")` | Coordinated bundle: pose clip + emotion + gaze + glow colour. `error` is locked for 1.8 s unless `stateMachine.set(s,{force:true})`; entering listening/thinking interrupts speech (barge-in); speech start/end drive `speaking`/`idle` automatically. `stateMachine.userTarget` sets where the eyes go. |

## Face

| Call | Behaviour |
|---|---|
| `setEmotion(name, intensity=1)` | `neutral, happy, sad, surprised, thinking, angry, curious, friendly, error` — smoothly blends eye/brow/mouth morphs. |
| `setEyeExpression(name\|null)` | Eyes only: `neutral, happy, sad, angry, surprised, curious, squint, wide, closed`. `null` returns control to the emotion. |
| `setMouthOpen(0..1\|null)` | Direct jaw/mouth opening (independent of speech); `null` releases. |
| `blink("both"\|"left"\|"right")`; `face.autoBlink` | Manual blink or **wink** one eye; random auto-blink (2–6 s, occasional double). |
| `setGlow(color?, boost?)`, `setEyeColor(color)` | Recolour emissive materials at runtime. |

## Gaze

| Call | Behaviour |
|---|---|
| `lookAt({x,y,z} \| Object3D \| null)` | World-space target; eyes lead, head/neck follow (70 % of the angle). An `Object3D` (e.g. the camera) is tracked every frame. `null` → idle wander (`gaze.idleWander`). |
| `setEyeDirection({yaw,pitch}\|null, eye="both"\|"left"\|"right")` | Steer both or **each eye independently** (±26° / ±19°); `null` follows `lookAt` again. |

## Direct joint control (absolute, clamped to natural limits)

| Call | Behaviour |
|---|---|
| `moveHead({yaw,pitch,roll}, {fade,hold,smooth})` | yaw + = left, pitch + = up, roll + = tilt left; combined head+neck range ±85°/±50°/±45°. |
| `moveArm("left"\|"right", {shoulder,abduction,twist,elbow,wrist,wristFlex,shrug}, opts)` | Only the given angles are overridden (others keep following the animation). Mirrors automatically; `shrug` raises/lowers the shoulder (clavicle, −15…25). |
| `moveTorso({yaw,pitch,roll}, opts)` | Upper-body turn/lean split 55 % spine / 45 % chest: yaw + = left (±60°), pitch + = lean forward (−30…45°), roll + = lean left (±25°). |
| `moveJoint(bone, {x,y,z}, opts)` | Raw joint-space angles for any bone in [RIG.md](RIG.md) (eyes excluded). |
| `releaseJoint(bone?)` | Return a joint (or all) to the animation. `hold` auto-releases after N seconds. |
| `getJointAngles(bone)`, `listJoints()` | Current angle, limits, whether overridden. |
| `setHand(side, "open"\|"relaxed"\|"fist"\|"point"\|"thumbsUp"\|"pinch" \| {thumb,index,middle,ring: 0..1})`, `releaseHand(side)` | Finger curl. |
| `pointAt({x,y,z}, {hand:"left"\|"right"\|"auto", hold, fingers, look})`, `stopPointing()` | Arm IK: wrist placed one hand-length before the target (clamped to reach), index finger extended, head/eyes look at it. |

## Locomotion

| Call | Behaviour |
|---|---|
| `walkTo({x,z}, {speed=0.8, facing?, tolerance=0.05})` → `Promise<boolean>` | Turns toward the goal first if it is behind, walks with planted-foot IK, resolves `true` on arrival (`false` if replaced/stopped). `facing` = world yaw in degrees (0 = +Z). |
| `turnTo(yawDeg)`, `turnBy(deg)` → `Promise<boolean>` | Turns in place by stepping. |
| `locomotion.walkForward(speed)`, `locomotion.stop()` | Continuous walk / decelerate and settle. |
| `stop()` | Stops speech, animations above idle, walking and pointing. |
| `resetPose({position?})` | Clears animations, overrides, IK, expression, gaze, speech, walking; feet re-planted; optionally back to the origin. |

## Speech

```ts
robot.speak({
  audioUrl: "/audio/hello.wav",   // or `audio` (pre-decoded) or neither
  text: "Hello",                  // optional with audio -> hybrid sync; alone -> TTS / silent preview
  lang: "en-US",                  // TTS voice language ("ar-SA"); visemes auto-detect the text script
  visemes: events,                // TTS timings (Azure/ElevenLabs/Rhubarb adapters) - preferred if provided
  lipSync: true, emotion: "friendly", gestures: true, rate: 1, tts: true,
}) // -> { finished: Promise, stop(), mode: "audio" | "tts" | "silent" }

const s = robot.speakStream({ sampleRate: 24000 });   // streaming PCM16 from a TTS service
s.pushPCM16(chunk); s.pushVisemes(events?); s.end();
```

- With **audio**: decoded + analysed offline, played on the Web Audio clock; the mouth is sampled from that clock (sync holds even at low FPS). Needs a user gesture (browser autoplay policy).
- With **text only**: browser `speechSynthesis` if a voice exists (re-synced on `boundary`), otherwise a silent timed preview (used by tests/headless).
- Events: `speech:start`, `speech:end {interrupted}`. `lipsync.offsetMs/gain/hybrid` tune sync. Details: [LIPSYNC.md](LIPSYNC.md).

## Data-driven motions (JSON) — see [MOTION_AUTHORING.md](MOTION_AUTHORING.md)

| Call | Behaviour |
|---|---|
| `registerMotion(json, {overwrite?})` → `{ok, def, errors[], warnings[]}` | Validates + compiles a JSON motion (semantic angles, sparse keys, events). Never throws; errors carry exact paths. On success it is playable with `playAnimation(name)`. Built-in names are protected. |
| `listMotions()`, `getMotion(name)` | Custom motion names; JSON of a custom or built-in motion (built-ins are sampled into raw keys). |
| `compileMotion`, `exportMotion`, `MOTION_SCHEMA` | Pure functions/schema usable without a robot (CI validation of motion files). |

## Events, status, lifecycle

`robot.on(type, fn)` / `once` / `off`, wildcard `"*"`. Types: `animation:start|end|blocked`, `emotion`, `state`, `speech:start|end`, `walk:start|end`, `command`, `error`.
`getStatus()` returns state, emotion, animations per channel, speaking, lipsync weights, gaze angles, locomotion, overrides. `after(seconds, fn)` / `delay(seconds)` run on robot time. `dispose()` releases geometries, materials, skeletons, mixer and the audio context.

## Not implemented / caveats (no façade)

- No arbitrary 3-D "reach with palm orientation"; `pointAt` aligns the hand with the forearm.
- IK covers legs and arms only; no full-body IK, no collision avoidance between arm and torso.
- `moveArm` abduction is limited to 88° (the Euler decomposition); raise the arm further with `shoulder` (flexion up to 190°).
- Browser `speechSynthesis` provides no audio data (see LIPSYNC.md).
