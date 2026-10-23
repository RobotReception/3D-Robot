import * as THREE from "three";
import type { ColorPart } from "./RobotAvatar";
import type { EmotionName } from "./FaceController";
import type { WalkOptions } from "./LocomotionController";
import type { AssistantState } from "./stateMachine";

/** A named spot the robot can walk to ("desk", "window"...): ground position + optional final facing (degrees, 0 = +Z). */
export interface Place {
  x: number;
  z: number;
  facing?: number;
}

export type MoveDir = "forward" | "back" | "left" | "right";
export type LookTarget = "user" | "left" | "right" | "up" | "down" | "forward";
export type GestureName = "greeting" | "goodbye" | "bow" | "nod" | "shake" | "happy" | "surprised" | "sad";

/** What a command or an LLM tag asks the robot to do. */
export type RobotAction =
  | { type: "move"; dir: MoveDir; meters: number; speed?: number }
  | { type: "turn"; deg: number } // + = left, - = right
  | { type: "stop" }
  | { type: "home" }
  | { type: "goto"; place: string }
  | { type: "gesture"; name: GestureName }
  | { type: "point"; target: "left" | "right" | "forward" | { place: string } }
  | { type: "look"; target: LookTarget }
  | { type: "emotion"; name: EmotionName }
  | { type: "think"; seconds?: number }
  | { type: "blink"; side?: "both" | "left" | "right" }
  | { type: "color"; part: ColorPart; color: string }
  | { type: "resetColors" }
  | { type: "say"; text: string };

export interface ActionResult {
  action: RobotAction;
  ok: boolean;
  /** why it did not (fully) happen */
  reason?: "blocked" | "unreachable" | "interrupted" | "invalid";
  /** move/goto: metres actually travelled / asked */
  moved?: number;
  requested?: number;
}

/** The parts of RobotAvatar the actions use (kept narrow so tests can fake it). */
export interface ActionRobot {
  root: { position: { x: number; z: number }; rotation: { y: number }; localToWorld(v: THREE.Vector3): THREE.Vector3 };
  walkTo(target: { x: number; z: number }, o?: WalkOptions): Promise<boolean>;
  turnBy(deg: number): Promise<boolean>;
  stop(): void;
  playAnimation(name: string): unknown;
  setEmotion(e: EmotionName): void;
  lookAt(t: { x: number; y: number; z: number } | THREE.Object3D | null): void;
  pointAt(t: { x: number; y: number; z: number }, o?: { hold?: number }): void;
  blink(eye?: "both" | "left" | "right"): void;
  setColors(c: Partial<Record<ColorPart, string>>): void;
  resetColors(): void;
  setState?(s: AssistantState): void;
  after(seconds: number, fn: () => void): void;
  defaultEmotion: EmotionName;
  lastWalk?: { adjusted: boolean; unreachable: boolean };
}

export interface ActionContext {
  places: Record<string, Place>;
  /** where "go back to your place" goes (default: where the assistant was created) */
  home: Place;
  /** longest single move (default 6 m) */
  maxMeters?: number;
  /** what "look at me" looks at (the camera / the user) */
  userTarget?: THREE.Object3D | null;
}

/** Standing spots in the reception lobby (see src/viewer/environments/lobby.ts), with Arabic/English aliases in chatCommands. */
export const LOBBY_PLACES: Record<string, Place> = {
  desk: { x: 0, z: -2.6, facing: 180 }, // in front of the reception desk, facing it
  window: { x: -6.6, z: 0.5, facing: -90 }, // at the glass wall, facing out
  bench: { x: 6.0, z: -0.6, facing: 90 }, // by the lounge bench
  center: { x: 0, z: 0, facing: 0 },
  front: { x: 0, z: 3, facing: 0 }, // toward the viewer ("come here")
  plant: { x: -2.35, z: -2.9, facing: 180 }, // beside the left plant by the desk
};

/** step length used for "take two steps" */
export const STEP_METERS = 0.45;
const DEG = 180 / Math.PI;
const DEFAULT_MAX = 6;
/** how long (robot seconds) a gesture keeps the sequence waiting when another action follows */
const GESTURE_SECONDS: Record<GestureName, number> = { greeting: 3, goodbye: 3.6, bow: 2.4, nod: 1.6, shake: 1.6, happy: 2.2, surprised: 2, sad: 2.6 };

const wait = (robot: ActionRobot, seconds: number) => new Promise<void>((r) => robot.after(seconds, r));
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

let lookToken = 0;

/** Perform one action. Walks and turns resolve when finished; `settle` makes gestures wait for their length. */
export async function executeAction(robot: ActionRobot, a: RobotAction, ctx: ActionContext, o: { settle?: boolean } = {}): Promise<ActionResult> {
  const here = () => ({ x: robot.root.position.x, z: robot.root.position.z });
  switch (a.type) {
    case "move": {
      const max = ctx.maxMeters ?? DEFAULT_MAX;
      const dist = clamp(a.meters, 0.1, max);
      const yaw = robot.root.rotation.y;
      const ang = yaw + (a.dir === "left" ? Math.PI / 2 : a.dir === "right" ? -Math.PI / 2 : a.dir === "back" ? Math.PI : 0);
      const from = here();
      const target = { x: from.x + Math.sin(ang) * dist, z: from.z + Math.cos(ang) * dist };
      // forward: just walk. back / sideways: a biped relocates (turn, walk) and then faces the way it faced before
      const ok = await robot.walkTo(target, { speed: a.speed, ...(a.dir === "forward" ? {} : { facing: yaw * DEG }) });
      const now = here();
      const moved = Math.hypot(now.x - from.x, now.z - from.z);
      if (robot.lastWalk?.unreachable) return { action: a, ok: false, reason: "unreachable", moved, requested: dist };
      if (!ok && moved < dist * 0.9) return { action: a, ok: false, reason: "interrupted", moved, requested: dist };
      if (moved < dist * 0.7 - 0.05) return { action: a, ok: false, reason: "blocked", moved, requested: dist };
      return { action: a, ok: true, moved, requested: dist };
    }
    case "turn": {
      const ok = await robot.turnBy(clamp(a.deg, -720, 720));
      return { action: a, ok, reason: ok ? undefined : "interrupted" };
    }
    case "stop":
      robot.stop();
      return { action: a, ok: true };
    case "home":
    case "goto": {
      const place = a.type === "home" ? ctx.home : ctx.places[a.place];
      if (!place) return { action: a, ok: false, reason: "invalid" };
      const from = here();
      const ok = await robot.walkTo({ x: place.x, z: place.z }, place.facing !== undefined ? { facing: place.facing } : {});
      const now = here();
      if (robot.lastWalk?.unreachable) return { action: a, ok: false, reason: "unreachable" };
      if (!ok) return { action: a, ok: false, reason: "interrupted", moved: Math.hypot(now.x - from.x, now.z - from.z) };
      const off = Math.hypot(now.x - place.x, now.z - place.z);
      return off > 0.5 ? { action: a, ok: false, reason: "blocked", moved: Math.hypot(now.x - from.x, now.z - from.z) } : { action: a, ok: true };
    }
    case "gesture":
      robot.playAnimation(a.name);
      if (o.settle) await wait(robot, GESTURE_SECONDS[a.name]);
      return { action: a, ok: true };
    case "point": {
      let world: THREE.Vector3;
      if (typeof a.target === "object") {
        const p = ctx.places[a.target.place];
        if (!p) return { action: a, ok: false, reason: "invalid" };
        world = new THREE.Vector3(p.x, 0.9, p.z);
      } else {
        const local = a.target === "left" ? [1.3, 1.25, 1.2] : a.target === "right" ? [-1.3, 1.25, 1.2] : [0, 1.3, 2.2];
        world = robot.root.localToWorld(new THREE.Vector3(local[0], local[1], local[2]));
      }
      robot.pointAt(world, { hold: 3 });
      if (o.settle) await wait(robot, 3.2);
      return { action: a, ok: true };
    }
    case "look": {
      const token = ++lookToken;
      if (a.target === "user") robot.lookAt(ctx.userTarget ?? null);
      else {
        const local = { left: [1.6, 1.55, 1.4], right: [-1.6, 1.55, 1.4], up: [0, 3, 1.2], down: [0, 0.2, 1.2], forward: [0, 1.55, 3] }[a.target];
        robot.lookAt(robot.root.localToWorld(new THREE.Vector3(local[0], local[1], local[2])));
        robot.after(3.5, () => token === lookToken && robot.lookAt(ctx.userTarget ?? null)); // then back to the user
      }
      return { action: a, ok: true };
    }
    case "emotion":
      robot.setEmotion(a.name);
      robot.after(6, () => robot.setEmotion(robot.defaultEmotion)); // a mood on request lasts a few seconds
      return { action: a, ok: true };
    case "think":
      robot.setState?.("thinking");
      robot.after(a.seconds ?? 4, () => robot.setState?.("idle"));
      return { action: a, ok: true };
    case "blink":
      robot.blink(a.side ?? "both");
      return { action: a, ok: true };
    case "color":
      robot.setColors({ [a.part]: a.color });
      return { action: a, ok: true };
    case "resetColors":
      robot.resetColors();
      return { action: a, ok: true };
    case "say":
      return { action: a, ok: true }; // spoken by the assistant, not the body
  }
}

/** Run actions one after the other (stops early if `signal` aborts). */
export async function executeActions(robot: ActionRobot, list: RobotAction[], ctx: ActionContext, signal?: AbortSignal): Promise<ActionResult[]> {
  const out: ActionResult[] = [];
  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) break;
    out.push(await executeAction(robot, list[i], ctx, { settle: i < list.length - 1 }));
  }
  return out;
}

// ======================================================================= tags from an LLM: [action=forward:2]
const NAMES = new Set<ColorPart>(["body", "trim", "uniform", "joints", "accent", "visor", "light", "eyes"]);
const num = (s: string | undefined, d: number) => {
  const n = s === undefined ? d : Number(s);
  return Number.isFinite(n) ? n : d;
};

/**
 * Parse the value of an `[action=...]` tag the model wrote:
 * `forward:2` `back:1` `left:1` `right:1` (metres) · `turn_left:90` `turn_right:90` (degrees) · `stop` `home`
 * · `goto:desk` · `look:user|left|right|up|down|forward` · `point:left|right|forward|<place>` · `think`.
 * Unknown / malformed values return null (ignored, never spoken).
 */
export function parseActionTag(value: string, places: string[] = Object.keys(LOBBY_PLACES)): RobotAction | null {
  const [name, a1, a2] = value.toLowerCase().split(":");
  switch (name) {
    case "forward": case "back": case "left": case "right":
      return { type: "move", dir: name, meters: clamp(num(a1, 1), 0.1, DEFAULT_MAX), speed: a2 ? num(a2, 0.8) : undefined };
    case "turn_left": return { type: "turn", deg: clamp(num(a1, 90), 1, 720) };
    case "turn_right": return { type: "turn", deg: -clamp(num(a1, 90), 1, 720) };
    case "turn": return { type: "turn", deg: clamp(num(a1, 90), -720, 720) };
    case "stop": return { type: "stop" };
    case "home": return { type: "home" };
    case "goto": return a1 && places.includes(a1) ? { type: "goto", place: a1 } : null;
    case "look": return a1 && ["user", "left", "right", "up", "down", "forward"].includes(a1) ? { type: "look", target: a1 as LookTarget } : null;
    case "point":
      if (a1 === "left" || a1 === "right" || a1 === "forward") return { type: "point", target: a1 };
      return a1 && places.includes(a1) ? { type: "point", target: { place: a1 } } : null;
    case "think": return { type: "think", seconds: a1 ? clamp(num(a1, 4), 1, 15) : undefined };
    case "blink": return { type: "blink" };
    case "color":
      return a1 && NAMES.has(a1 as ColorPart) && a2 && /^[0-9a-f]{6}$/.test(a2) ? { type: "color", part: a1 as ColorPart, color: "#" + a2 } : null;
    default: return null;
  }
}
