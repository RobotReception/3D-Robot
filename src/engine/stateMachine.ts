import * as THREE from "three";
import type { RobotAvatar } from "./RobotAvatar";

export type AssistantState = "idle" | "listening" | "thinking" | "speaking" | "error";
export const ASSISTANT_STATES: AssistantState[] = ["idle", "listening", "thinking", "speaking", "error"];

/** Higher wins when states compete (error > speaking > thinking/listening > idle). */
export const STATE_PRIORITY: Record<AssistantState, number> = { idle: 0, listening: 2, thinking: 2, speaking: 3, error: 5 };

const GLOW: Record<AssistantState, string> = {
  idle: "#59d0ff", listening: "#5bff9a", thinking: "#ffbf47", speaking: "#59d0ff", error: "#ff4f5e",
};

export interface SetStateOptions {
  /** bypass the error lock */
  force?: boolean;
  fromSpeech?: boolean;
}

/**
 * Conversation-level behaviour. Each state sets a coordinated bundle (base pose clip,
 * emotion, gaze, glow colour):
 *
 *   idle      natural standing, friendly neutral face, idle gaze wander (or on the user)
 *   listening lean in, head tilt, attentive face, green glow, eyes on the user
 *   thinking  hand-to-chin pose, thinking face, amber glow, gaze up/away
 *   speaking  talk gestures + lip sync (started by robot.speak), cyan glow
 *   error     apologetic shrug + head shake, red glow; locks for ~1.8 s then returns to idle
 *
 * Rule: `error` cannot be pre-empted for 1.8 s unless `force`. Entering listening/thinking
 * while speaking interrupts the speech (barge-in). Everything else is last-writer-wins.
 */
export class AssistantStateMachine {
  state: AssistantState = "idle";
  /** where the eyes go in idle/listening/speaking: a world point or an object (camera, user marker) */
  userTarget: THREE.Vector3 | THREE.Object3D | null = null;
  /** state entered after speech ends */
  afterSpeech: AssistantState = "idle";
  private errorUntil = 0;
  private clock = 0;
  private errorTimer: number | null = null;

  constructor(private robot: RobotAvatar) {}

  update(dt: number) {
    this.clock += dt;
    if (this.errorTimer !== null) {
      this.errorTimer -= dt;
      if (this.errorTimer <= 0) {
        this.errorTimer = null;
        if (this.state === "error") this.set("idle", { force: true });
      }
    }
  }

  can(to: AssistantState, force = false): boolean {
    if (force) return true;
    if (this.state === "error" && this.clock < this.errorUntil && to !== "error") return false;
    return true;
  }

  set(to: AssistantState, o: SetStateOptions = {}): boolean {
    if (!(to in STATE_PRIORITY)) throw new Error(`Unknown state "${to}"`);
    if (to === this.state) return true;
    if (!this.can(to, o.force)) return false;
    const r = this.robot;
    const from = this.state;
    // exit
    if (from === "listening") r.animation.stop("listening");
    if (from === "thinking") r.animation.stop("thinking");
    if (from === "speaking" && !o.fromSpeech && (to === "listening" || to === "thinking" || to === "idle" || to === "error")) {
      r.stopSpeech();
    }
    this.state = to;
    // enter
    r.setGlow(GLOW[to], to === "error" ? 0.8 : 0);
    switch (to) {
      case "idle":
        r.animation.stop("listening");
        r.animation.stop("thinking");
        if (!r.speaking) r.setEmotion("neutral");
        this.lookAtUser();
        break;
      case "listening":
        r.animation.play("listening");
        r.setEmotion("friendly", 0.7);
        r.setEyeExpression(null);
        this.lookAtUser();
        break;
      case "thinking":
        r.animation.play("thinking");
        r.setEmotion("thinking");
        r.lookAt(r.root.localToWorld(new THREE.Vector3(-0.6, 1.75, 1.1)));
        break;
      case "speaking":
        r.animation.stop("listening");
        r.animation.stop("thinking");
        if (r.face.emotion.name === "neutral" || r.face.emotion.name === "thinking") r.setEmotion("friendly", 0.6);
        this.lookAtUser();
        break;
      case "error":
        r.animation.play("error", { force: true });
        r.setEmotion("error");
        this.errorUntil = this.clock + 1.8;
        this.errorTimer = 2.4;
        break;
    }
    r.emit("state", { from, to });
    return true;
  }

  speechEnded() {
    if (this.state === "speaking") this.set(this.afterSpeech, { force: true, fromSpeech: true });
  }

  reset() {
    this.state = "idle";
    this.errorTimer = null;
    this.errorUntil = 0;
  }

  private lookAtUser() {
    const r = this.robot;
    if (this.userTarget) r.lookAt(this.userTarget as THREE.Vector3 & THREE.Object3D);
    else r.lookAt(null);
  }
}
