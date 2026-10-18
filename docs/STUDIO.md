# Control Studio

`npm run dev` → http://localhost:5173 (production build: `npm run build && npx vite preview`).

![Studio](screenshots/studio-cam-full.png)

**Viewer (left)** — drag = orbit 360°, wheel = zoom, preset buttons Full / Upper / Face / Side / Back (animated), Quality (low/medium/high), Background (studio, light, dusk, green, transparent), Reset pose, Screenshot (PNG), Style (premium/friendly/futuristic), English ⇄ العربية (RTL). **Click the robot** to select the nearest joint (marker shown) — the Joints tab switches to it.

**Motion** — assistant states, every animation (loop option, stop, reset), speed multiplier, live "who owns each channel" tags, 9 emotions, 9 eye expressions, walk-to (x,z) / turns / continuous walk, gaze mode (free / follow cursor / look at camera), hand presets, IK pointing.
**Joints** — selected joint with X/Y/Z sliders (limits shown, live current angle, override indicator, release), head yaw/pitch/roll, eye direction, mouth open, blink, both arms (shoulder, abduction, twist, elbow, wrist, wrist flex) and 4 fingers each.
**Audio** — text to speak (EN/AR samples, language, rate, silent preview), audio upload (+ optional transcript), demo clips (`vowels.wav` for audio analysis, `hello.wav` + "hello" for hybrid), lip-sync mode (hybrid / audio only / text only), **sync offset, mouth gain, hybrid gate**, live viseme meters and a **timeline** (viseme events, loudness envelope, playhead).
**Developer** — FPS, render ms, engine CPU ms, draw calls, triangles, geometries/textures, pixel ratio, JS heap (Chromium); JSON command console with examples; WebSocket client; live `getStatus()`; event log.

Hooks for automation: `window.robot`, `window.viewer`, `window.studio`.
