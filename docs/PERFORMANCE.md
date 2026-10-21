# Performance, quality tiers, compatibility

## Budget (measured on the shipped model)

| Item | Value | How measured |
|---|---|---|
| Triangles | 29,272 per pass for the v1 styles, **74,232 for Concierge** (the renderer counter doubles with the shadow pass) | geometry index counts; `renderer.info` |
| Draw calls | 11 skinned meshes per pass | `renderer.info.render.calls` = 27 in the full Studio scene (main + shadow + floor + grid + ring) |
| Bones / morph targets | 40 / 43 | `tests/model.test.ts` |
| File size | 390 KB (Meshopt) vs 2.4 MB raw | `npm run model:build` |
| Engine CPU per frame | **0.19 ms** (Node, walking + speaking + gaze + IK + morphs) / **0.4–0.5 ms** inside Chromium while the page is also software-rendering | `tests/api.test.ts` perf test; Developer panel |
| Memory | geometry count constant (27) across 6 style switches | E2E "style switching ... does not leak" |

The 60 FPS target is therefore limited only by the GPU: the CPU side uses ~1–3 % of a 16.6 ms frame. **Actual GPU frame rates were not measured** (the test machine has no GPU; Chromium used SwiftShader at ≈ 10 FPS, which says nothing about real hardware). Expect 60 FPS on any integrated GPU of the last decade at "high"; verify on your target devices with the Developer panel.

## Quality tiers (`RobotViewer.setQuality`)

| | low | medium | high |
|---|---|---|---|
| Pixel ratio cap | 1 | 1.5 | 2 |
| Selective bloom (glow) | off | off | off (optional via `viewer.setBloom(true)`) |
| Shadows | off | 1024 map | 2048 map |
| Env-map intensity / tone mapping | 0.65 / ACES | 0.65 / ACES | 0.65 / ACES |
| Grid | hidden by default (toggle via `showGrid`) | hidden by default (toggle via `showGrid`) | hidden by default (toggle via `showGrid`) |

Switching recompiles materials once; verified in E2E (pixel ratio and shadow flag change).

## Resource handling

- `ResizeObserver` keeps canvas + camera aspect in sync (tested: container 1040→600 px).
- `dispose()` on viewer/avatar frees geometries, skeletons, materials, mixer, audio context; PMREM env map and renderer are released; `webglcontextlost/restored` pause/resume the loop.
- Pose proxy + per-channel baked clips are created once; per-frame allocations are limited to small temporaries.

## Compatibility

- Requires WebGL2/WebGL1-capable browsers; without WebGL the Studio shows an explanatory message (tested with WebGL disabled). WebGPU is not used (research: three.js falls back to WebGL2 anyway).
- **Tested:** Chromium (headless, SwiftShader) on Windows and Linux at 1440×900, 1000×700 and a 390×844 touch emulation (no horizontal scroll). **Not tested here:** Firefox, Edge, Safari, real Android/iOS devices. Standard APIs only (WebGL2, Web Audio, ResizeObserver, Pointer Events); `speechSynthesis` is optional.
