import * as THREE from "three";
import type { FaceController } from "./FaceController";
import type { LipSyncController } from "./lipsync/LipSyncController";
import { VISEME_OPENNESS, type VisemeEvent } from "./lipsync/visemes";
import { armPose, eulerOrderFor, eulerToQuat, headPose, type JointSpace, type RawPose, type Side } from "./rig";

/** A moment in the speech the body reacts to. Times are on the lip-sync timeline (seconds). */
export interface Cue {
  t: number;
  /** start: first sound of a phrase · accent: stressed syllable · boundary: a pause begins */
  kind: "start" | "accent" | "boundary";
  /** 0..1 */
  strength: number;
  /** punctuation that closes the phrase ("." "," "?" "!" ...) on boundaries */
  mark?: string;
}

const PAUSE_BREAK = 0.14; // silence this long ends a phrase
const gauss = (x: number, mu: number, s: number) => Math.exp(-0.5 * ((x - mu) / s) ** 2);
const smooth = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
const isQuestion = (m?: string) => m === "?" || m === "؟";

/**
 * Prosody from a viseme timeline: phrase starts, pauses (with the punctuation that caused them) and accents.
 * Text-derived events carry `accent` (stressed content words) and `mark`; events from audio analysis do not, so
 * accents are then taken from the strongest, longest open vowels, at most one every ~0.45 s (speech rhythm).
 */
export function deriveCues(events: VisemeEvent[]): Cue[] {
  const cues: Cue[] = [];
  const hasAccent = events.some((e) => e.accent !== undefined);
  let inPhrase = false, lastEnd = 0, lastEv: VisemeEvent | null = null, lastAccent = -9;
  const closePhrase = (t: number, mark: string | undefined, dur: number) => {
    cues.push({ t, kind: "boundary", strength: Math.min(1, Math.max(0.3, dur / 0.4)), mark });
    inPhrase = false;
  };
  for (const e of events) {
    const dur = e.duration ?? 0.12;
    if (e.viseme === "sil") {
      if (inPhrase && dur >= PAUSE_BREAK) closePhrase(e.time, e.mark ?? lastEv?.endMark, dur);
      continue;
    }
    if (inPhrase && e.time - lastEnd >= PAUSE_BREAK) closePhrase(lastEnd, lastEv?.endMark, e.time - lastEnd); // aligned audio: silence has no event
    if (!inPhrase) {
      cues.push({ t: e.time, kind: "start", strength: 0.6 });
      inPhrase = true;
    }
    if (hasAccent) {
      if (e.accent !== undefined && e.accent >= 0.5) {
        cues.push({ t: e.time + Math.min(0.04, dur * 0.3), kind: "accent", strength: e.accent });
        lastAccent = e.time;
      }
    } else if ((VISEME_OPENNESS[e.viseme] ?? 0) >= 0.55 && (e.weight ?? 1) * dur >= 0.07 && e.time - lastAccent >= 0.45) {
      cues.push({ t: e.time + Math.min(0.04, dur * 0.3), kind: "accent", strength: 0.62 });
      lastAccent = e.time;
    }
    lastEnd = e.time + dur;
    lastEv = e;
  }
  if (inPhrase) cues.push({ t: lastEnd, kind: "boundary", strength: 0.9, mark: lastEv?.endMark ?? "." });
  return cues.sort((a, b) => a.t - b.t);
}

export interface PerformerOptions {
  rng?: () => number;
  /** can this arm take beat gestures right now? (not pointing / reaching / manually overridden) */
  armFree: (side: Side) => boolean;
}

/**
 * Co-speech body language driven by what is actually being said (not looping animations):
 *
 *   accent       head nod · eyebrow raise · hand beat (alternating hands, the stroke lands ON the stressed syllable)
 *   phrase start head lift + a small glance away (alternating sides)
 *   pause        blink; "." slow nod · "," tiny nod · "!" strong nod · "?" head tilts up + inner brows rise before the pause
 *
 * Everything is a smooth function of the timeline clock and the cues (known in advance, so the gesture preparation
 * starts BEFORE the stress), layered on top of the clips with `applyDelta`. Live audio without a timeline falls back to
 * energy onsets/peaks. `intensity` 0..1 scales it all; `head/brows/hands/blinks` switch parts off.
 */
export class SpeechPerformer {
  enabled = true;
  intensity = 1;
  head = true;
  brows = true;
  hands = true;
  blinks = true;
  /** set per utterance by speak({ gestures: false }) */
  speechGestures = true;

  private level = 0; // smoothed 0..1 "performing" amount (fades in and out with speech)
  private cues: Cue[] = [];
  private srcLen = -1;
  private src: VisemeEvent[] | null = null;
  private blinked = new Set<number>();
  private beatHand = new Map<Cue, { side: Side; both: boolean }>();
  private armW: Record<Side, number> = { L: 1, R: 1 };
  private liveT = 0;
  private liveMean = 0;
  private liveLast = -9;
  private liveQuiet = 0;
  private liveInPhrase = false;
  private rng: () => number;
  private q = new THREE.Quaternion();

  constructor(private joints: JointSpace, private face: FaceController, private lipsync: LipSyncController, private o: PerformerOptions) {
    this.rng = o.rng ?? Math.random;
  }

  get amount() {
    return this.level;
  }
  /** the cues currently driving the performance (for visualisation / tests) */
  get activeCues() {
    return this.cues;
  }

  update(dt: number) {
    const on = this.enabled && this.intensity > 0 && this.lipsync.active;
    this.level += ((on ? 1 : 0) - this.level) * (1 - Math.exp(-dt / (on ? 0.2 : 0.25)));
    if (this.level < 1e-3) {
      if (!on) this.reset();
      this.face.setSpeechBrow(0, 0);
      return;
    }
    const events = this.lipsync.events;
    let now: number;
    if (events.length) {
      if (events !== this.src || events.length !== this.srcLen) {
        this.src = events;
        this.srcLen = events.length;
        this.cues = deriveCues(events);
      }
      now = this.lipsync.currentTime;
    } else {
      this.liveT += dt;
      now = this.liveT;
      this.liveCues(dt);
    }
    this.perform(now);
  }

  private reset() {
    this.cues = [];
    this.src = null;
    this.srcLen = -1;
    this.blinked.clear();
    this.beatHand.clear();
    this.liveT = this.liveMean = 0;
    this.liveLast = -9;
    this.liveQuiet = 0;
    this.liveInPhrase = false;
  }

  /** no timeline (live microphone / stream): react to loudness onsets and peaks */
  private liveCues(dt: number) {
    const e = this.lipsync.energy;
    this.liveMean += (e - this.liveMean) * (1 - Math.exp(-dt / 1.2));
    if (e < 0.1) this.liveQuiet += dt;
    else {
      if (!this.liveInPhrase && this.liveQuiet > 0.2) {
        this.cues.push({ t: this.liveT, kind: "start", strength: 0.6 });
        this.liveInPhrase = true;
      }
      this.liveQuiet = 0;
    }
    if (this.liveInPhrase && this.liveQuiet > 0.35) {
      this.cues.push({ t: this.liveT - this.liveQuiet, kind: "boundary", strength: 0.8, mark: "." });
      this.liveInPhrase = false;
    }
    if (e > 0.5 && e > this.liveMean * 1.35 && this.liveT - this.liveLast > 0.45) {
      this.cues.push({ t: this.liveT, kind: "accent", strength: 0.65 });
      this.liveLast = this.liveT;
    }
    if (this.cues.length > 200) this.cues.splice(0, this.cues.length - 200);
  }

  private perform(now: number) {
    const k = this.level * this.intensity;
    let nod = 0, roll = 0, yaw = 0, lift = 0, lean = 0, browUp = 0, browIn = 0;
    const stroke: Record<Side, number> = { L: 0, R: 0 };
    let strongIdx = 0;
    for (let i = 0; i < this.cues.length; i++) {
      const c = this.cues[i];
      const x = now - c.t;
      if (c.kind === "accent" && c.strength >= 0.6) strongIdx++;
      if (x < -0.7) break; // sorted: later cues are further in the future
      if (x > 1.2) continue;
      if (c.kind === "accent") {
        // only the important words move the head and brows noticeably (strength^1.5 / ^2)
        nod += 3.8 * c.strength ** 1.5 * gauss(x, 0.04, 0.09);
        browUp += 0.34 * c.strength ** 2 * gauss(x, -0.03, 0.12);
        lean += c.strength * gauss(x, 0.02, 0.16);
        if (c.strength >= 0.6) {
          let h = this.beatHand.get(c);
          if (!h) {
            h = { side: (["R", "L", "R", "R", "L", "R"] as Side[])[strongIdx % 6], both: c.strength >= 0.95 };
            this.beatHand.set(c, h);
          }
          // preparation (arm rises) starts 0.3 s BEFORE the stress, the stroke lands on it, then a slower retraction
          const s = x < -0.3 ? 0 : x < 0 ? smooth((x + 0.3) / 0.3) : x < 0.55 ? 1 - smooth(x / 0.55) : 0;
          const a = s * (0.55 + 0.45 * c.strength);
          stroke[h.side] = Math.max(stroke[h.side], a);
          if (h.both) stroke[h.side === "R" ? "L" : "R"] = Math.max(stroke[h.side === "R" ? "L" : "R"], a * 0.6);
        }
      } else if (c.kind === "start") {
        lift += 1.6 * gauss(x, 0.3, 0.3);
        const side = Math.floor(c.t * 7.3) % 2 ? 1 : -1; // alternating, deterministic per cue
        yaw += side * 4.5 * gauss(x, 0.35, 0.28) * c.strength;
      } else {
        // boundary
        if (isQuestion(c.mark)) {
          const r = smooth((x + 0.55) / 0.55) * (1 - smooth((x - 0.3) / 0.55)); // tilt up BEFORE the pause, hold, release
          nod -= 5 * r;
          roll += 4.5 * r;
          browIn += 0.6 * r;
          browUp += 0.45 * r;
        } else if (c.mark === "!") {
          nod += 5.5 * gauss(x, 0.04, 0.14);
          browUp += 0.6 * gauss(x, -0.05, 0.16);
        } else if (c.mark === "," || c.mark === "،" || c.mark === ";" || c.mark === "؛" || c.mark === ":") nod += 1.8 * gauss(x, 0.05, 0.12);
        else nod += 3.2 * c.strength * gauss(x, 0.06, 0.2);
        if (this.blinks && !this.blinked.has(i) && x >= 0.04) {
          this.blinked.add(i);
          if (this.rng() < 0.8) this.face.blink();
        }
      }
    }
    if (this.head) {
      const e = headPose({ pitch: (-nod + lift) * k, yaw: yaw * k, roll: roll * k });
      this.applyQuat("head", { x: e[0] * 0.65, y: e[1] * 0.65, z: e[2] * 0.7 }, "YXZ");
      this.applyQuat("neck", { x: e[0] * 0.35, y: e[1] * 0.35, z: e[2] * 0.3 }, "YXZ");
      this.applyQuat("spine", { x: 1.3 * lean * k, y: 0, z: 0 }, "YXZ");
    }
    this.face.setSpeechBrow(this.brows ? Math.min(1, browUp * k) : 0, this.brows ? Math.min(1, browIn * k) : 0);
    if (this.hands && this.speechGestures) {
      for (const side of ["L", "R"] as Side[]) {
        const free = this.o.armFree(side);
        this.armW[side] += ((free ? 1 : 0) - this.armW[side]) * 0.2;
        const s = stroke[side] * this.armW[side] * k * (side === "R" ? 1 : 0.82);
        if (s < 1e-3) continue;
        const pose: RawPose = armPose(side, { shoulder: 9 * s, abduction: 3.5 * s, elbow: 15 * s, twist: 5 * s, wristFlex: -9 * s });
        for (const [bone, e] of Object.entries(pose)) this.applyQuat(bone, { x: e[0], y: e[1], z: e[2] }, eulerOrderFor(bone));
      }
    }
  }

  private applyQuat(bone: string, e: { x: number; y: number; z: number }, order: Parameters<typeof eulerToQuat>[1]) {
    if (!this.joints.has(bone)) return;
    this.joints.applyDelta(bone, eulerToQuat(e, order, this.q));
  }
}
