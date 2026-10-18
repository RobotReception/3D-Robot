# Testing & acceptance evidence

```bash
npm test               # 89 tests, ~6 s: headless engine tests on the real shipped GLBs (all three styles)
npm run test:e2e       # 27 browser tests: builds, serves dist/, drives the Studio in Chromium (WebGL)
                       # CHROME_PATH=/path/to/chrome to choose the browser; SKIP_BUILD=1 to reuse dist/
npm run typecheck && npm run build
```

Results of the last run: **89/89 unit-integration tests** and **26/27 browser tests** passed. Screenshots written by the E2E run are in `docs/screenshots/`.

## What the unit/integration tests prove (Node, real GLB, no mocks)

| File | Tests | Evidence |
|---|---|---|
| `model.test.ts` (×3 styles) | 9 | every model is fully skinned, has the 40 bones and all 43 morph targets, ≤ 12 draw calls, < 70 k triangles, PBR materials, correct left/right orientation, straight legs |
| `rig.test.ts` | 5 | joint-space maths, limits + mirroring, same semantic command ⇒ mirrored hand positions, sign conventions checked with forward kinematics (shoulder raises forward, abduction outward, head yaw/pitch) |
| `animation.test.ts` | 12 | all required states exist; **every clip moves bones, stays inside joint limits, no NaN**; one-shots return to idle; no pose pops while cross-fading; priority conflict rejection + `animation:blocked`; speak + point + look in parallel; paused loops resume; replay/restart bug regression |
| `face.test.ts` | 6 | each emotion drives its characteristic morphs; smooth transitions; eye-expression override only affects eyes; blink (manual + auto); `setMouthOpen`; influences always in 0…1 |
| `lipsync.test.ts` | 24 | EN/AR text → visemes (harakat, shadda, implicit vowels, mixed text), timing fit, Azure/Rhubarb/word/character adapters, FFT, formant recovery, **audio analysis at 16/22.05/44.1 kHz** (≥ 90 % labels correct, median onset error ≤ 60 ms), silence/noise → closed mouth, hybrid alignment, offset control, loudness gating, streaming events, live frame source, full EN/AR speech flow, peak timing |
| `locomotion.test.ts` | 10 | arrives within 7 cm and resolves; **stance feet slide < 4 mm per frame**; ankles reach IK targets (< 25 mm) and never sink; pelvis bob < 7 cm, lateral < 6 cm; turn accuracy < 3° by stepping; turns before walking when the goal is behind; squat-bounce keeps feet planted (< 1 cm drift) and knees flex; works for all styles |
| `api.test.ts` | 23 | every Robot API call changes the expected bones/morphs: `moveHead`, `moveArm`, `moveJoint`, limits/clamping, fingers, `lookAt` (point and moving object), `setEyeDirection` (per eye), wink, `moveTorso`, shrug, `pointAt` IK (fingertip within 12 cm of a reachable target; straight arm when out of reach), `resetPose`; state machine (bundles, error lock, barge-in); JSON commands (validation, sequence, parallel, wait, speak), transport bridge; **engine update = 0.19 ms/frame**; dispose |

## What the browser tests prove (real Chromium, WebGL via SwiftShader)

Boot (40 bones, no console errors) · robot visible from full/face/side/back cameras (pixel check) · orbit + zoom · animation buttons really raise the hand, priorities respected · all 12 animation chips run and return to idle · emotion/eye chips drive real morph targets · walk button reaches the target · joint sliders rotate the real bone and respect limits · **click-to-pick joints** · head/arm/mouth sliders · JSON console incl. error reply · lighting + background controls · stats panel · **real audio lip-sync** · hybrid sync · EN/AR silent speech · quality tiers · style switching without GPU-memory growth · resize · Arabic RTL UI · **WebSocket bridge with a real `ws` server** · minimal embed + React Three Fiber example · phone viewport (390×844, touch) without horizontal scroll · graceful message with WebGL disabled.

### Lip-sync numbers (honest conditions)

| Test | Result |
|---|---|
| Vowels `aa E I O U` + `s` synthesised by formant synthesis, played through Web Audio in Chromium, mouth sampled every ~6 ms | aa 27/27, E 27/27, I 27/27, O 28/28, U 27/27, SS 23/23 samples matched the expected viseme (segment interiors) |
| Silence between vowels | mouth open in < 35 % of samples (test threshold) |
| Hybrid: synthetic "hello" clip + text `hello` | mean opening 0.11 in the leading silence, 0.93 during speech, 0.00 in the tail |
| Offline analysis (Node) at 16/22.05/44.1 kHz | all labelled segments correct; onset ≈ 20–40 ms |

**These are synthetic signals** (steady vowels, noise bursts) chosen because their ground truth is known. They show that the pipeline, timing and clock sync work; they do **not** show accuracy on natural speech, accents, noise, or any commercial TTS. Perform your own listening test with real recordings before relying on audio-only sync, or use TTS-provided timings.

## Not covered (be aware)

- Firefox/Edge/Safari and real mobile devices; GPU frame rate; thermal/battery behaviour.
- Browser `speechSynthesis` with real voices (none in the test machine); Draco-compressed models; KTX2.
- Automated collision checks between limbs/torso for arbitrary custom poses; visual regression of renders (screenshots are artifacts, not assertions, except the "robot is visible" pixel check).
- Long-running soak tests / memory growth beyond the style-switching check.

## Visual QA helpers (not assertions)

`tools/sheet.mjs` + `tools/montage.py` render pose/emotion/viseme contact sheets from the real engine (used to tune poses and produce `docs/screenshots/design-directions.png`); `tools/studio_shot.mjs` screenshots the Studio. They need the dev server (`npm run dev`) and a Chromium binary.
