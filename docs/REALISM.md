# Realism upgrade — execution record

Design direction: industrial product robot with deep LED face, applied to all five styles,
budget ~1.5–2 MB / ~200 K triangles per model. Phase records below are appended
chronologically (phase 0 first, newest at the bottom).

## Environment (verified 2026-10-22)

- Toolchain: node v24.19, Chrome + Edge present (playwright-core detection works on Windows).
- `bpy` (Blender as a Python module) requires **Python 3.11 or 3.13** wheels — system Python 3.12
  has **no wheel** ("versions: none"). Installed **Python 3.13.15** via winget and created:
  - Venv: **`.venv-bpy/`** → `bpy 5.2.2 LTS` + `numpy` + `Pillow`.
  - Build command: `.venv-bpy/Scripts/python.exe blender/build_robot.py --style <style> --out …`
    (verified: premium builds, 40 bones, height 1.569 — script is bpy 5-compatible).
- `blender/build_robot.py` runs unchanged on bpy 5.x (glTF export, shape keys, materials all pass).

## Baseline ("before") renders

- **Reuse contract**: `tools/baseline_poses.json` — the identical 9-pose list (front / side / back /
  face happy / greeting / thinking / pointing / happy / walking) × 5 styles. The "after" run must
  use the *same file* so shots are comparable.
- Command: `node tools/baseline.mjs --tag before --serve`
  (usage in later phases: `--tag after`). Output: `docs/screenshots/baseline/<tag>/`.
  - 45 single shots (`<style>_<nn>_<pose>.png`, 420×520)
  - per-style contact sheets `sheet_<tag>_<style>.png` + `sheet_<tag>_overview.png`
  - Sheet labels slate background (16,19,26), 3 columns; overview 5 columns.
- Dev-server note (Windows, cold cache): vite dependency re-optimisation delays first request by
  ~30s; the tool waits up to 300 s. If the port is already up, omit `--serve`.
- Dev helpers made cross-platform in phase 0: `tools/sheet.mjs` now detects Chromium like
  `tests/e2e/run.mjs` (Chrome/Edge fallback) and writes to `SHEET_DIR` (env, default
  `tests/e2e/out/sheet`) instead of the hardcoded Linux `/opt/pw-browsers` + `/tmp/claude-0`.

## Known differences vs the old doc sheets

- The old `concierge-sheet.png`/`mascot-sheet.png` were shot with slightly different pose timing;
  from now on `tools/baseline_poses.json` is the single source of truth for realism comparisons.

## Phase 1 executed — textured atlases, AO/normal bakes, emissive (2026-10-22)

### What ships
- **`blender/atlas.py`** — numpy+PIL kit: `SLOTS` (2048² per-style atlas; shell 1024², face/visor/
  dark/accent/uniform 512², shell2 512², glow 256²), `FACE_SUB` (fixed sub-rects for the five LED
  face meshes), noise primitives (fbm / stretched weave / speckles / blobs), `spread_field`,
  `Look` + `build_metal_rough` (per-family rough/metal patches, G=rough B=metal channels),
  `draw_face_emissive` (LED eye/brow/mouth gradients + glow slot), `image_to_rgba` (returns RGB,
  top-down after row flip — bake buffers are bottom-up).
- **`build_robot.py::texturize(...)`** (invoked automatically by `build()` whenever textures are
  on; CLI: `--tex-dir assets/textures/<style> --samples N [--no-tex]`):
  1. `_uv_tile` Smart-UVs each body mesh, then normalises its uv bbox into an absolute atlas px
     rect (`_tile_grid` splits each family slot into a per-object grid, biggest meshes first);
  2. face meshes get planar (x,z) UVs into their fixed `FACE_SUB` rect;
  3. **per-object full-atlas 2048 bakes** (`_bake_full` / `_bake_full_bumped` with a temporary
     noise-bumped material swap) feed AO into the colour canvas and tangent-space NORMAL into the
     normal canvas (both sliced back by the tile rect); `PUMP` sets per-family bump distance/scale;
  4. MR atlas composed from per-family `Look`s (matching the flat-mode values in `make_material`);
  5. emissive canvas drawn from `face_layout` + style glow; Mat_Face/Mat_Glow get the emissive map;
  6. `_wire_material` attaches colour/metalRough/normal (+emissive) nodes for every family;
  7. slicers/edges of the pipeline re-fetch uv layers after any edit-mode trip (stale uv-layer
     references across bmesh rebuilds caused mesh corruption + heap Crash on Windows).
- Output: `assets/textures/<style>/<style>_{color.jpg, metal_rough.jpg, normal.png, emissive.png}`.

### The four UV/export landmines (all fixed; keep in mind for phase 2+)
1. **Stale uv-layer references** — after smart-UV edit-mode round trip, `layer.data` dies; always
   re-fetch `me.uv_layers["atlas"]` after `mode_set(OBJECT)`. This was the non-deterministic
   `0xC0000374` heap crash root.
2. **Extra uv layers** — ops-built meshes carry a junk `UVMap` layer that the exporter exports as
   TEXCOORD_0 (samples the white void → chrome-white robots). `_isolate_atlas_uv` deletes every
   other layer and stays sole + active.
3. **glTF-transform meshopt quantizes TEXCOORD into int16 without a dequantization scale that
   three.js honours** — decoded uvs come out ×65536 → every texture samples a constant texel.
   Workaround: `_shift_uv(obj, +1.0)` right before export; wrapping (REPEAT) makes +1 a visual
   no-op, but out-of-range uvs make the quantizer **skip** TEXCOORD and keep exact float32.
4. **v axis** — the exporter stores `v = 1 − blender_v`; with flipY=false sampling,
   `row = v_glb × H`. Authoring `v = py/ATLAS` + saving every bitmap **flipped top-down**
   (`_save_canvas` does `FLIP_TOP_BOTTOM`) makes the sampler walk the exact canvas rows the
   bake/canvas math assumed. (Authoring `v = py/ATLAS` alone = mirrored sampling: LED eyes read
   the accent tile → brown "wood" eyes.)

### Engine side (`src/engine/appearance.ts`)
- v2 models (textures present: `map || normalMap`) skip the flat-finish pass entirely; Mat_Visor
  keeps `envMapIntensity ≥ 0.8`. `RobotAvatar.eyeGlow` stays default-off (natural idle); state
  machine / speaking paths still dim/pulse as designed.

### Results (public/models, meshopt --level high)
| style | glb | noted |
|---|---|---|
| friendly | 651,836 B | white shell + graphite joints + copper accents, LED face lit |
| futuristic | 652,536 B | gunmetal + violet neon face/rings |
| premium | 652,456 B | satin silver + gold accents, soft cyan LED |
| mascot | 820,768 B | big glossy head, dark glass panel, blue LED face |
| concierge | 1,059,552 B | humanoid, navy uniform panels, glow joint rings |

All ≤ 2 MB budget. Raw glbs live in `assets/models/*.raw.glb` (rig.json carries `design_version:2`
+ textures dict).

### Verification
- Screenshots: `docs/screenshots/baseline/phase1/` (57 files: 45 poses + 6 sheets + manifests),
  re-rendered with `node tools/baseline.mjs --tag phase1` (vite started separately; port 5173).
- `npm test`: 11 files / **117 tests pass** (jsdom environment for model tests; loader now copies
  model bytes into a same-realm ArrayBuffer — node-realm buffer slices failed `instanceof`).
- `npm run typecheck`: clean.
- Browser probes during bring-up verified: every material binds baseColour + metallicRoughness
  (G=rough, B=metal) + normal (+emissive on Mat_Face/Mat_Glow); sampled roughness/metalness read
  correct per-family values; LED face samples the emissive blue ©️ not the accent slab.

### Known follow-ups (phase 2 face depth + polish)
- LED gradients still blobby-wide (grinning mouth band floods its sub-rect); refine shapes/sizes.
- chrome-highlight sparkle on joints = normal quantization (10-bit) + sharp env; consider
  KHR_materials_clearcoat tuning or smoothness boost in `appearance.ts`.
- `tools/build_models.sh` now passes `--tex-dir`/`--samples 16` (rebuilds stay textured).
- Debug helper `tools/uv_bounds.py` reads raw-glb TEXCOORD ranges (kept for phase 2+ debugging).

## Next: phase 2 — face depth (LED grille, emotion rendering)

## Phase 2 executed — pro LED face depth + normal econ (2026-10-22)

### Face redraw (`blender/atlas.py`)
- `draw_face_emissive` rebuilt around local-frame helpers (drift-proof, grille + soft.Round
  masks): `_rr_mask` (soft rounded-rect), `_grille` (LED-matrix seams), `_teeth`(mouth bar),
  `_blend_add` (clipped additive paste; accepts slot offsets; int coords), `_eye_mask`
  (bezel floor + superellipse core + specular dot).
- Eyes = LED-wall lenses: cell `max(9, rw*0.055)`, seam gap 2.3, dim **0.78** (calm: emotion
  morphs squeeze the emissive gradient — lower contrast stopped the static-grain look).
- Brows = three tilted pill dashes per brow; mouth = pill bar with LED teeth
  (`dim 0.65`); glow slot stays a flat fill; `hide_idle` (mascot) keeps brows/mouth off.
- **NEW `draw_face_color(canvas, info, layout)`** — off-state hardware in the FACE slot of the
  colour atlas: multiply-darkened bezel (`dk=0.10`) per feature + faint LED dots
  (`glow*0.081`) inside eye lenses so the resting face reads as an LED module behind glass
  (was plain paint). Wired in `texturize` right after `draw_face_emissive`.
- Both drawers blend at full-canvas coords via `SLOTS["face"]` offset; `_blend_add` casts the
  paste origin to int (float rects crashed the numpy slicing).

### Normal map economics (the 2 MB crunch)
- Restored the phase-1 per-object bump bakes lost in a build-script regression:
  `_bake_full_bumped(obj, samples, dist, scale)` — saves the material's Normal links, wires
  `Noise -> Bump (distance=PUMP[fam], scale=…) -> Principled.Normal` for one TANGENT bake, then
  restores. Body tiles + face sub-rects bake into the normal canvas; `PUMP` softened to broad,
  gentle undulations (features ≥ ~4 mm, 30-60 % lower amplitude than phase 1) — high-frequency
  grain was both the chrome-sparkle feel and a bitrate bomb (baked normal PNG = 4.2 MB).
- Save path: `_save_canvas(..., down=2)` — normal saved at **1024² JPG q92 / subsampling 0**
  (4:4:4; subsample never on linear tangent data), 2048² colour / emissive preserved. LANCZOS
  downscale runs after the top-down flip.
- Textures per style now ≈ 474 KB colour JPG + ~110 KB MR + ~340 KB normal JPG + 59 KB
  emissive PNG.

### Style tweaks
- Visor roughness 0.06 → 0.09 (`_style_knobs`) — defocuses the glass env-streak above the brow
  (physical reflection; closeups still show a soft highlight, accepted).

### Results (public/models, meshopt --level high)
| style | glb | noted |
|---|---|---|
| friendly | 1,316,840 B | LED wall eyes, off-state bezel, calmer joints |
| futuristic | 1,215,764 B | gunmetal + violet rings |
| premium | 1,309,996 B | satin + gold, cyan LED |
| concierge | 1,895,808 B | humanoid, uniform, glow rings (closest to cap) |
| mascot | 1,325,540 B | big glossy head, happy crescents |

All ≤ 2 MB. Sizes grew vs phase 1 because the baked bump normals ride along (vs the
procedural-only intermediate); budget still holds.

### Verification
- No-bpy visual unit test of `draw_face_emissive`/`draw_face_color` (face-slot crops, idle +
  on-state compositing) before any build.
- `node tools/probe_phase2.mjs friendly` (kept in `tools/`): idle + happy closeups via the dev
  server — eyes/mouth matrix reads as hardware LED, crescent noise calm after dim 0.6→0.78.
- Baseline: `node tools/baseline.mjs --tag phase2` → `docs/screenshots/baseline/phase2/`
  (45 poses + sheets), all 5 styles spot-checked.
- `npm test`: 11 files / 117 pass; `npm run typecheck`: clean.

### Follow-ups (phase 3 kit joints)
- Face-happy crescents still carry a faint sampled-gradient grain — acceptable; revisit only if
  closeups zoom further.
- Visor glass env-streak: consider engine-side `envMapIntensity` trim (appearance.ts) in
  phase 3 if it reads as a smudge in marketing renders.
- `concierge` at 1.90 MB leaves only ~0.19 MB headroom; if phase 3 adds geometry, trim first
  (fewer `--samples` is texture-side only; colour JPG q90 saves ~40 KB).
