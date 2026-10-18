# Authoring motions (by hand, by tools, or by an AI)

A motion is **plain JSON**: a few keyframes with *semantic* angles (head yaw, elbow flexion…). The engine validates it, clamps every angle to the natural joint range, blends it with everything else (priorities, cross-fades, IK feet, speech, gaze) and plays it. No code, no rig knowledge.
Implemented in `src/engine/motionJson.ts` (tested in `tests/motion.test.ts`); JSON Schema: [`motion.schema.json`](motion.schema.json); examples: all 15 built-ins as data in [`motions/`](motions/) ([catalogue](MOTIONS.md)).

## Minimal example

```json
{
  "name": "proudWave",
  "duration": 2.4,
  "priority": 6,
  "keys": [
    { "t": 0,   "armR": { "shoulder": 0,  "abduction": 0,  "elbow": 10,  "twist": 0  }, "handR": "relaxed", "head": { "yaw": 0, "roll": 0 } },
    { "t": 0.5, "armR": { "shoulder": 10, "abduction": 80, "elbow": 96,  "twist": 78 }, "handR": "open",    "head": { "yaw": -10, "roll": 6 } },
    { "t": 1.1, "armR": { "elbow": 120 } },
    { "t": 1.7, "armR": { "elbow": 80 } },
    { "t": 2.4, "armR": { "shoulder": 0, "abduction": 0, "elbow": 10, "twist": 0 }, "handR": "relaxed", "head": { "yaw": 0, "roll": 0 } }
  ],
  "events": [ { "t": 0.4, "emotion": "happy" }, { "t": 2.0, "emotion": "neutral" } ]
}
```

Register + play: `robot.registerMotion(json); robot.playAnimation("proudWave")`, or one command: `{"cmd":"registerMotion","motion":{…},"play":true}`, or over HTTP `POST /v1/motions?play=1` ([REMOTE_API.md](REMOTE_API.md)).

## Format

| Field | Meaning |
|---|---|
| `name` | unique id `^[a-z][a-zA-Z0-9_-]{1,40}$`; built-in names are protected; re-registering needs `overwrite` |
| `duration` | 0.2 – 30 s |
| `loop` | `true` = repeats; make the **first and last key identical** (a warning is returned otherwise) |
| `priority` | 1–8, default 6: 3 speech gesture · 5 head nod/shake · 6 emotive one-shot · 8 commanded gesture. Higher wins a channel, lower loops resume afterwards ([ANIMATION.md](ANIMATION.md)) |
| `fadeIn`/`fadeOut` | 0.01–3 s cross-fade (default 0.35) |
| `easing` | `smooth` (default, ease-in/out between keys) or `linear` |
| `keys` | 2–240 keys `{t, …}`; sorted automatically; max `t` = `duration` |
| `events` | ≤ 60 `{t, emotion?, intensity?, eyeExpression?, blink?}` fired during playback |

**Sparse keys:** each *parameter* has its own timeline. A parameter you do not mention at a key keeps interpolating between the keys where it *is* mentioned (e.g. `elbow` above is keyed at 0, 0.5, 1.1, 1.7, 2.4; the shoulder only at 0, 0.5, 2.4). Before its first key a parameter eases from rest (0); after its last key it holds.
**Channels** are derived from what you animate (`head`, `torso`, `armL/armR`, `fingersL/R`); only those channels are taken, so a head-only motion never disturbs the arms. Legs belong to locomotion IK; a pelvis offset makes the legs bend while the feet stay planted.

## Parameters (degrees; ranges are enforced, out-of-range values are clamped and reported as warnings)

| Group | Parameter | Meaning | Range |
|---|---|---|---|
| `head` | `yaw` | turn, **+ = to the robot's left** | combined ±85 |
| | `pitch` | **+ = look up** | −50…50 |
| | `roll` | **+ = tilt toward left shoulder** | ±45 |
| `torso` | `yaw` / `pitch` / `roll` | + = turn left / lean forward / lean left | ±60 / −30…45 / ±25 |
| `armL`, `armR` (mirrored automatically) | `shoulder` | forward raise (+) / backward (−): 90 = horizontal forward, 180 = straight up | −60…190 |
| | `abduction` | sideways raise away from the body, 90 = horizontal | −30…88 |
| | `twist` | upper-arm rotation about its axis (needed to fold the forearm *up* after raising sideways: ≈ 78) | ±95 |
| | `elbow` | flexion, 0 = straight | 0…150 |
| | `wrist` | forearm twist (palm facing) | ±85 |
| | `wristFlex` | hand bend (+ = forward/up) | ±70 |
| | `shrug` | shoulder up (+) / down (−) | −15…25 |
| `handL`, `handR` | preset `open relaxed fist point thumbsUp pinch` or `{thumb,index,middle,ring}` curl | 0 = straight, 1 = fully curled | 0…1 |
| `pelvis` | `x` `y` `z` | translation in **meters** (x left, y up, z forward); negative `y` = squat | ±0.08 |
| `raw` | `{ "bone": [x,y,z] }` | any head/torso/arm/finger bone in raw joint space ([RIG.md](RIG.md)); how the built-in exports are written | per joint |

Note `shoulder` is the *semantic* angle (+ = forward raise); in raw joint space it is the negative X axis. Use semantic parameters when writing by hand.

## What makes a motion look professional (rules the AI prompt below encodes)

1. **Anticipation → action → settle.** Start with a small opposite move (0.15–0.3 s), do the main move, then ease back; avoid ending abruptly (the engine fades out to idle for you).
2. **Overshoot + settle** on fast moves (go 10 % beyond the target, come back in the next key).
3. **Ease, don't snap:** 0.25–0.6 s between poses for gestures; 0.1–0.2 s only for punches (nods, flinches). `smooth` easing is default.
4. **Follow-through & overlap:** head starts 0.05–0.1 s after the torso, hands after the forearm, fingers last.
5. **Asymmetry:** never mirror both arms exactly; vary timing by 0.1–0.2 s and amplitude by 10–20 %.
6. **Weight:** add small `pelvis.y` dips (−0.01…−0.03 m) and `torso.pitch` (2–6°) on strong gestures.
7. **Keep the face in sync:** use `events` for emotion/blink at the emotional beat (blink at the start of a head turn is natural).
8. **Stay inside comfort:** wave heights/elbow angles in the catalogue are good reference values; keep abduction < 85, elbow 40–130 for hand gestures.
9. **Loops:** periodic functions, 1–3 s per cycle, small amplitude (3–15°), `priority` 1–3.
10. **Duration:** gestures 1.5–4 s; reactions 0.6–1.5 s.

## Generating motions with an AI

**Workflow (generate → validate → repair → preview):**
1. Give the model the schema ([`motion.schema.json`](motion.schema.json), or `GET /v1/schema/motion`), the rules above, 1–2 examples from [`motions/`](motions/) (or `GET /v1/motions/greeting`), and the user's request.
2. Send its JSON to `registerMotion` / `POST /v1/motions`. On failure you receive **exact paths + messages** (`keys[2].armR.elbow: number (degrees)`); feed them back and ask for a corrected JSON (usually 1 round).
3. Show warnings to the model (clamped joints, loop pops) and optionally ask for a refinement.
4. Play it (`play: true`) and optionally let a human approve/rate it; keep good ones as files and register them at start-up.

**System prompt template** (copy/paste):

```text
You design short robot body-language motions as JSON that follows the attached JSON Schema (RobotMotion).
Rules: angles in degrees using the semantic parameters (head yaw + = left, pitch + = up; armX shoulder + = forward/up,
abduction + = sideways, elbow 0 = straight, twist ~78 to fold the forearm up after a sideways raise).
Use 5-12 keys per motion, 1.5-4 s for gestures. Always: anticipation, main action with slight overshoot, settle back to the
first pose. Vary left/right timing, add small torso.pitch and pelvis.y (negative = squat, meters, |y|<=0.03) on strong beats,
move the head slightly after the arm, add 1-3 events for emotion/blink. Hand presets: open, relaxed, fist, point, thumbsUp, pinch.
Prefer ease between poses of 0.25-0.6 s. Output ONLY the JSON object. Unmentioned parameters stay at rest, so only animate what the gesture needs.
```

**Python sketch** (illustrative, **not executed in this repository's tests**; the HTTP endpoints it calls are tested):

```python
import json, requests
API = "http://localhost:8787"; H = {"Authorization": "Bearer secret"}
schema = requests.get(f"{API}/v1/schema/motion", headers=H).json()["result"]
example = requests.get(f"{API}/v1/motions/greeting", headers=H).json()["result"]

def ask_llm(messages) -> dict: ...   # your LLM call, constrained to `schema`, returns a dict

messages = [{"role": "user", "content": f"Schema: {json.dumps(schema)}\nExample: {json.dumps(example)}\nMake a shy, hesitant wave."}]
for attempt in range(3):
    motion = ask_llm(messages)
    r = requests.post(f"{API}/v1/motions?play=1&overwrite=1", json=motion, headers=H)
    if r.status_code == 201:
        print("playing; warnings:", r.json()["result"]["warnings"]); break
    messages += [{"role": "assistant", "content": json.dumps(motion)},
                 {"role": "user", "content": "Rejected: " + r.json()["error"] + "\nFix and return the full JSON."}]
```

## Limits & honesty

- The engine guarantees *valid, safe-range, smoothly blended* motion; it cannot judge whether a motion looks good — that is why the preview/approve step exists. Quality of AI output depends on the model and prompt; expect to iterate.
- No collision check between hand and body: keep `abduction` ≥ 0 for the arm that is beside the torso, and test visually (Studio → Motion → play, orbit the camera).
- No full-body or leg authoring: legs are driven by locomotion/IK; use `walkTo` / `turnTo` and `pelvis.y` for squats.
- Registered motions live in memory of the page; persist the JSON yourself (database/file) and re-register at start-up.
