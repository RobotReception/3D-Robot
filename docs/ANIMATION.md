# Animation system

## Concepts

- **Channels** split the skeleton so independent motions can run together: `head` (neck, head), `torso` (pelvis, spine, chest; also pelvis translation), `armL`, `armR` (clavicle→hand), `fingersL`, `fingersR`. **Legs are not a clip channel**: they belong to the IK/locomotion controller.
- A **clip** (`ClipDef`) is a pure function `pose(t)` → joint angles (+ optional pelvis offset), authored with semantic helpers (`armPose`, `headPose`, `fingerPose`). At registration it is *baked* into one `THREE.AnimationClip` **per channel** (30 Hz, quaternion tracks in the bone's true local frame, hemisphere-continuous).
- **Priorities**: 0 base idle · 1 state poses (listening/thinking) · 3 speech gestures · 5 head nod/shake · 6 emotive one-shots (greeting, happy, sad, surprised, error, goodbye, bow) · 8 commanded gestures (pointing).
- Each channel keeps a **stack**; the highest priority wins the channel. Lower *loops* stay paused underneath and **resume** when the winner ends (e.g. talking hand gesture resumes after pointing). One-shots finish and fade out to what is below. Winner changes **cross-fade** via normalised weights (`fadeIn`/`fadeOut`, default 0.35 s).
- **Conflicts**: a request for a channel owned by a higher priority is *rejected for that channel* (not blended), reported in `PlayResult.rejected` and the `animation:blocked` event; `force: true` takes the channel. Equal priority replaces. Disjoint channels run in parallel (speak + point + look).
- **Layer order each frame** (`RobotAvatar.update`): clips (mixer on a pose proxy, copied to bones) → behaviours (speech head-bob, walking arm-swing/lean) → gaze (head/neck/eyes) → locomotion + leg IK → arm IK reach → direct joint overrides → lip-sync → face morphs → glow.
- **Direct control** (`moveHead`, `moveArm`, `moveJoint`, `setHand`) uses `JointOverrides`: absolute values on the requested axes, clamped to the limits, blended in/out; other axes keep following the animation.
- **IK**: analytic two-bone solver (law of cosines, pole vector). Legs: feet are *planted in world space*; the pelvis drops just enough for both legs to reach, so bounce/squat/weight-shift authored on the pelvis never lifts a foot. Arms: `pointAt` solves shoulder→wrist to a world target (clamped to reach).
- **Locomotion**: stepping state machine (swing arc + landing prediction, speed-dependent cadence), `walkTo`, `turnTo/turnBy` (turns by stepping), final facing, arrival tolerance, speed ramps. Foot sliding < 4 mm/frame in tests.

## Built-in clips (generated from the code)

<!-- clips:start -->
<!-- clips:end -->

Required states map as: Idle/Listening/Thinking/Happy/Sad/Surprised/Greeting/Pointing/Error/Goodbye = clips above; **Speaking** = `robot.speak()` (talk gestures + lip-sync + head-bob); **Walking/Turning** = locomotion (`playAnimation("walking")`, `walkTo`, `turnTo`).

## Adding your own clip

```ts
import { armPose, headPose, merge } from "./src";

robot.animation.register({
  name: "shrugBig",
  duration: 1.6, loop: false, priority: 6,
  channels: ["armL", "armR", "head"],
  pose: (t, u) => {
    const e = Math.sin(Math.PI * u);              // 0 → 1 → 0
    return { joints: merge(
      armPose("L", { shoulder: 10 * e, abduction: 40 * e, elbow: 70 * e }),
      armPose("R", { shoulder: 10 * e, abduction: 40 * e, elbow: 70 * e }),
      { head: headPose({ roll: 8 * e }) as [number, number, number] },
    ) };
  },
});
robot.playAnimation("shrugBig");
```

Loops must be periodic (`pose(0) == pose(duration)`). Keep angles inside [RIG.md](RIG.md) limits (the test-suite pattern in `tests/animation.test.ts` checks every clip).

## Known limitation

AnimationMixer's "write only when changed" optimisation would let additive layers accumulate on held poses; the engine animates a hidden proxy skeleton and copies it to the real bones every frame to avoid that (see `AnimationController`).
