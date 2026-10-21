# Testing & acceptance evidence

Run `npm test` for engine, bridge lifecycle, concurrent Studio loading, and remote HTTP/WebSocket security regression tests. Run `npm run build` for strict TypeScript checks and production output.

For browser checks, run `npx playwright-core install chromium` once, then `npm run test:e2e`. The runner detects installed Chromium, Chrome or Edge on Windows; set `CHROME_PATH` to override. Browser screenshots and the JSON report are written to `tests/e2e/out/`, leaving documentation images untouched. CI installs Chromium and runs this suite after building.

```bash
npm test               # 111 tests, ~4 s: headless engine tests on the real shipped GLBs (all three styles)
npm run test:e2e       # 28 browser tests: builds, serves dist/, drives the Studio in Chromium (WebGL)
                       # CHROME_PATH=/path/to/chrome to choose the browser; SKIP_BUILD=1 to reuse dist/
npm run typecheck && npm run build
```

Results of the last run: **111/111 unit-integration tests** and **28/28 browser tests** passed. Screenshots written by the E2E run are in `tests/e2e/out/screenshots/`.

## What the unit/integration tests prove (Node, real GLB, no mocks)

| File | Tests | Evidence |
|---|---|---|
| `model.test.ts` (×5 styles) | 15 | every model is fully skinned, has the 40 bones and all 43 morph targets, ≤ 12 draw calls, < 70 k triangles, PBR materials, correct left/right orientation, straight legs |
| `rig.test.ts` | 5 | joint-space maths, limits + mirroring, same semantic command ⇒ mirrored hand positions, sign conventions checked with forward kinematics (shoulder raises forward, abduction outward, head yaw/pitch) |
| `animation.test.ts` | 12 | all required states exist; **every clip moves bones, stays inside joint limits, no NaN**; one-shots return to idle; no pose pops while cross-fading; priority conflict rejection + `animation:blocked`; speak + point + look in parallel; paused loops resume; replay/restart bug regression |
| `face.test.ts` | 6 | each emotion drives its characteristic morphs; smooth transitions; eye-expression override only affects eyes; blink (manual + auto); `setMouthOpen`; influences always in 0…1 |
| `lipsync.test.ts` | 24 | EN/AR text → visemes (harakat, shadda, implicit vowels, mixed text), timing fit, Azure/Rhubarb/word/character adapters, FFT, formant recovery, **audio analysis at 16/22.05/44.1 kHz** (≥ 90 % labels correct, median onset error ≤ 60 ms), silence/noise → closed mouth, hybrid alignment, offset control, loudness gating, streaming events, live frame source, full EN/AR speech flow, peak timing |
| `locomotion.test.ts` | 10 | arrives within 7 cm and resolves; **stance feet slide < 4 mm per frame**; ankles reach IK targets (< 25 mm) and never sink; pelvis bob < 7 cm, lateral < 6 cm; turn accuracy < 3° by stepping; turns before walking when the goal is behind; squat-bounce keeps feet planted (< 1 cm drift) and knees flex; works for friendly/futuristic/concierge/mascot (different leg lengths) |
| `motion.test.ts` | 7 | JSON motions: compile/register/play moves real bones, events, precise validation errors, limit clamping + loop warnings, built-in protection, **every built-in exports to JSON and re-compiles within 12° of the original**, JSON commands |
| `api.test.ts` | 23 | every Robot API call changes the expected bones/morphs: `moveHead`, `moveArm`, `moveJoint`, limits/clamping, fingers, `lookAt` (point and moving object), `setEyeDirection` (per eye), wink, `moveTorso`, shrug, `pointAt` IK (fingertip within 12 cm of a reachable target; straight arm when out of reach), `resetPose`; state machine (bundles, error lock, barge-in); JSON commands (validation, sequence, parallel, wait, speak), transport bridge; **engine update = 0.19 ms/frame**; dispose |
| `bridge.test.ts` | 2 | detach ignores late commands, including legacy transports; closing a connection cancels a pending reconnect |
| `remote-api.test.ts` | 4 | HTTP/WebSocket authentication, reply isolation by robot, immediate settlement on disconnect, body/command/timeout limits |
| `studio.test.ts` | 3 | concurrent model loads keep only the latest request; a failed replacement keeps the current robot; a load finishing after unmount is disposed |

## What the browser tests prove (real Chromium, WebGL via SwiftShader)

Boot (40 bones, no console errors) · robot visible from full/face/side/back cameras (pixel check) · orbit + zoom · animation buttons really raise the hand, priorities respected · all 12 animation chips run and return to idle · emotion/eye chips drive real morph targets · walk button reaches the target · joint sliders rotate the real bone and respect limits · **click-to-pick joints** · head/arm/mouth sliders · JSON console incl. error reply · lighting + background controls · stats panel · **real audio lip-sync** · hybrid sync · EN/AR silent speech · quality tiers · style switching without GPU-memory growth · resize · Arabic RTL UI · **WebSocket bridge with a real `ws` server** · **remote HTTP API (API key, register motion, commands, status, schema)** · minimal embed + React Three Fiber example · phone viewport (390×844, touch) without horizontal scroll · graceful message with WebGL disabled.

### Lip-sync numbers (honest conditions)

| Test | Result |
|---|---|
| Vowels `aa E I O U` + `s` synthesised by formant synthesis, played through Web Audio in Chromium, mouth sampled every ~6 ms | aa 15/15, E 13/13, I 15/15, O 13/13, U 13/13, SS 11/11 samples matched the expected viseme (segment interiors) |
| Silence between vowels | mouth open in < 35 % of samples (test threshold) |
| Hybrid: synthetic "hello" clip + text `hello` | mean opening 0.14 in the leading silence, 0.94 during speech, 0.01 in the tail |
| Offline analysis (Node) at 16/22.05/44.1 kHz | all labelled segments correct; onset ≈ 20–40 ms |

**These are synthetic signals** (steady vowels, noise bursts) chosen because their ground truth is known. They show that the pipeline, timing and clock sync work; they do **not** show accuracy on natural speech, accents, noise, or any commercial TTS. Perform your own listening test with real recordings before relying on audio-only sync, or use TTS-provided timings.

## Not covered (be aware)

- Firefox/Edge/Safari and real mobile devices; GPU frame rate; thermal/battery behaviour.
- Browser `speechSynthesis` with real voices (none in the test machine); Draco-compressed models; KTX2.
- Automated collision checks between limbs/torso for arbitrary custom poses; visual regression of renders (screenshots are artifacts, not assertions, except the "robot is visible" pixel check).
- Long-running soak tests / memory growth beyond the style-switching check.

## Visual QA helpers (not assertions)

`tools/sheet.mjs` + `tools/montage.py` render pose/emotion/viseme contact sheets from the real engine (used to tune poses and produce `docs/screenshots/design-directions.png`); `tools/studio_shot.mjs` screenshots the Studio. They need the dev server (`npm run dev`) and a Chromium binary.
