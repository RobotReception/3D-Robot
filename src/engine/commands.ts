import type { Channel } from "./clips";
import { EMOTIONS, EYE_EXPRESSIONS, type EmotionName, type EyeExpression } from "./FaceController";
import type { RobotAvatar, Vec3 } from "./RobotAvatar";
import { ASSISTANT_STATES, type AssistantState } from "./stateMachine";
import type { FingerCurl } from "./rig";
import type { VisemeEvent } from "./lipsync/visemes";

/**
 * JSON command protocol. Every command is a plain object with a `cmd` discriminator,
 * so it can arrive over WebSocket / postMessage / an LLM tool call.
 * See docs/COMMANDS.md for the full reference.
 */
export type RobotCommand =
  | { cmd: "playAnimation"; name: string; speed?: number; priority?: number; loop?: boolean; fadeIn?: number; channels?: Channel[]; force?: boolean; wait?: boolean }
  | { cmd: "stopAnimation"; name?: string }
  | { cmd: "setEmotion"; emotion: EmotionName; intensity?: number }
  | { cmd: "setEyeExpression"; expression: EyeExpression | null }
  | { cmd: "lookAt"; target: Vec3 | null }
  | { cmd: "moveHead"; yaw?: number; pitch?: number; roll?: number; fade?: number; hold?: number }
  | { cmd: "moveArm"; side: "left" | "right"; shoulder?: number; abduction?: number; twist?: number; elbow?: number; wrist?: number; wristFlex?: number; fade?: number; hold?: number }
  | { cmd: "moveJoint"; bone: string; x?: number; y?: number; z?: number; fade?: number; hold?: number }
  | { cmd: "releaseJoint"; bone?: string }
  | { cmd: "setHand"; side: "left" | "right"; pose?: string; curl?: FingerCurl }
  | { cmd: "pointAt"; target: Vec3; hand?: "left" | "right" | "auto"; hold?: number }
  | { cmd: "setMouthOpen"; value: number | null }
  | { cmd: "blink" }
  | { cmd: "walkTo"; x: number; z: number; speed?: number; facing?: number; wait?: boolean }
  | { cmd: "turn"; degrees?: number; to?: number; wait?: boolean }
  | { cmd: "speak"; text?: string; audioUrl?: string; lang?: string; emotion?: EmotionName; lipSync?: boolean; gestures?: boolean; rate?: number; visemes?: VisemeEvent[]; tts?: boolean; wait?: boolean }
  | { cmd: "setState"; state: AssistantState }
  | { cmd: "setSpeed"; value: number }
  | { cmd: "setGlow"; color?: string; boost?: number }
  | { cmd: "stop" }
  | { cmd: "resetPose"; position?: boolean }
  | { cmd: "wait"; seconds: number }
  | { cmd: "sequence"; steps: RobotCommand[] }
  | { cmd: "parallel"; steps: RobotCommand[] }
  | { cmd: "getStatus" };

export const COMMAND_NAMES = [
  "playAnimation", "stopAnimation", "setEmotion", "setEyeExpression", "lookAt", "moveHead", "moveArm", "moveJoint", "releaseJoint",
  "setHand", "pointAt", "setMouthOpen", "blink", "walkTo", "turn", "speak", "setState", "setSpeed", "setGlow", "stop", "resetPose",
  "wait", "sequence", "parallel", "getStatus",
] as const;

export interface CommandResult {
  ok: boolean;
  /** echoes the request `id` if one was provided */
  id?: string | number;
  cmd?: string;
  result?: unknown;
  error?: string;
}

export class CommandError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function num(c: Record<string, unknown>, k: string, req = true): number | undefined {
  const v = c[k];
  if (v === undefined || v === null) {
    if (req) throw new CommandError(`"${k}" is required (number)`);
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new CommandError(`"${k}" must be a finite number`);
  return v;
}
function str(c: Record<string, unknown>, k: string, req = true): string | undefined {
  const v = c[k];
  if (v === undefined || v === null) {
    if (req) throw new CommandError(`"${k}" is required (string)`);
    return undefined;
  }
  if (typeof v !== "string") throw new CommandError(`"${k}" must be a string`);
  return v;
}
function vec(v: unknown, k: string): Vec3 {
  if (!isObj(v)) throw new CommandError(`"${k}" must be {x,y,z}`);
  return { x: num(v, "x")!, y: num(v, "y")!, z: num(v, "z")! };
}
function oneOf<T extends string>(v: string | undefined, list: readonly T[], k: string): T {
  if (!v || !(list as readonly string[]).includes(v)) throw new CommandError(`"${k}" must be one of: ${list.join(", ")}`);
  return v as T;
}
function side(c: Record<string, unknown>): "left" | "right" {
  return oneOf(str(c, "side"), ["left", "right"] as const, "side");
}
const opts = (c: Record<string, unknown>) => ({ fade: num(c, "fade", false), hold: num(c, "hold", false) });

/** Execute one command (or array of commands) against a robot. Never throws: errors are returned in the result. */
export async function executeCommand(robot: RobotAvatar, raw: unknown): Promise<CommandResult> {
  if (Array.isArray(raw)) {
    const results: CommandResult[] = [];
    for (const r of raw) results.push(await executeCommand(robot, r));
    return { ok: results.every((r) => r.ok), result: results };
  }
  const id = isObj(raw) ? (raw.id as string | number | undefined) : undefined;
  try {
    if (!isObj(raw) || typeof raw.cmd !== "string") throw new CommandError('a command must be an object with a string "cmd"');
    const result = await run(robot, raw);
    robot.emit("command", { cmd: raw.cmd, ok: true });
    return { ok: true, id, cmd: raw.cmd, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    robot.emit("command", { cmd: isObj(raw) ? String(raw.cmd) : "?", ok: false, error: message });
    return { ok: false, id, cmd: isObj(raw) ? String(raw.cmd) : undefined, error: message };
  }
}

/** Parse a JSON string and execute it. */
export async function executeMessage(robot: RobotAvatar, json: string): Promise<CommandResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  return executeCommand(robot, parsed);
}

async function run(robot: RobotAvatar, c: Record<string, unknown>): Promise<unknown> {
  const cmd = c.cmd as string;
  switch (cmd) {
    case "playAnimation": {
      const name = str(c, "name")!;
      const h = robot.playAnimation(name, {
        speed: num(c, "speed", false), priority: num(c, "priority", false), fadeIn: num(c, "fadeIn", false),
        loop: typeof c.loop === "boolean" ? c.loop : undefined, channels: c.channels as Channel[] | undefined, force: c.force === true,
      });
      if (c.wait) await h.finished;
      return { accepted: h.accepted, rejected: h.rejected };
    }
    case "stopAnimation":
      robot.stopAnimation(str(c, "name", false));
      return;
    case "setEmotion":
      robot.setEmotion(oneOf(str(c, "emotion"), EMOTIONS, "emotion"), num(c, "intensity", false) ?? 1);
      return;
    case "setEyeExpression": {
      const e = c.expression;
      robot.setEyeExpression(e === null || e === undefined ? null : oneOf(str(c, "expression"), EYE_EXPRESSIONS, "expression"));
      return;
    }
    case "lookAt":
      robot.lookAt(c.target === null || c.target === undefined ? null : vec(c.target, "target"));
      return;
    case "moveHead":
      robot.moveHead({ yaw: num(c, "yaw", false), pitch: num(c, "pitch", false), roll: num(c, "roll", false) }, opts(c));
      return;
    case "moveArm":
      robot.moveArm(side(c), {
        shoulder: num(c, "shoulder", false), abduction: num(c, "abduction", false), twist: num(c, "twist", false),
        elbow: num(c, "elbow", false), wrist: num(c, "wrist", false), wristFlex: num(c, "wristFlex", false),
      }, opts(c));
      return;
    case "moveJoint":
      robot.moveJoint(str(c, "bone")!, { x: num(c, "x", false), y: num(c, "y", false), z: num(c, "z", false) }, opts(c));
      return;
    case "releaseJoint":
      robot.releaseJoint(str(c, "bone", false));
      return;
    case "setHand":
      robot.setHand(side(c), (c.curl as FingerCurl | undefined) ?? (str(c, "pose") as never));
      return;
    case "pointAt":
      robot.pointAt(vec(c.target, "target"), { hand: c.hand as "left" | "right" | "auto" | undefined, hold: num(c, "hold", false) });
      return;
    case "setMouthOpen":
      robot.setMouthOpen(c.value === null ? null : num(c, "value")!);
      return;
    case "blink":
      robot.blink();
      return;
    case "walkTo": {
      const p = robot.walkTo({ x: num(c, "x")!, z: num(c, "z")! }, { speed: num(c, "speed", false), facing: num(c, "facing", false) });
      if (c.wait) return { arrived: await p };
      return;
    }
    case "turn": {
      const to = num(c, "to", false);
      const p = to !== undefined ? robot.turnTo(to) : robot.turnBy(num(c, "degrees")!);
      if (c.wait) return { completed: await p };
      return;
    }
    case "speak": {
      const h = robot.speak({
        text: str(c, "text", false), audioUrl: str(c, "audioUrl", false), lang: str(c, "lang", false),
        emotion: c.emotion === undefined ? undefined : oneOf(str(c, "emotion"), EMOTIONS, "emotion"),
        lipSync: typeof c.lipSync === "boolean" ? c.lipSync : undefined, gestures: typeof c.gestures === "boolean" ? c.gestures : undefined,
        rate: num(c, "rate", false), visemes: c.visemes as VisemeEvent[] | undefined, tts: typeof c.tts === "boolean" ? c.tts : undefined,
      });
      if (c.wait) await h.finished;
      return { mode: h.mode };
    }
    case "setState": {
      const ok = robot.stateMachine.set(oneOf(str(c, "state"), ASSISTANT_STATES, "state"));
      if (!ok) throw new CommandError("state change refused (error state is locked briefly)");
      return;
    }
    case "setSpeed":
      robot.setSpeed(num(c, "value")!);
      return;
    case "setGlow":
      robot.setGlow(str(c, "color", false), num(c, "boost", false) ?? 0);
      return;
    case "stop":
      robot.stop();
      return;
    case "resetPose":
      robot.resetPose({ position: c.position === true });
      return;
    case "wait":
      await robot.delay(num(c, "seconds")!);
      return;
    case "sequence": {
      if (!Array.isArray(c.steps)) throw new CommandError('"steps" must be an array');
      const out: CommandResult[] = [];
      for (const step of c.steps) {
        // inside a sequence, motion commands finish before the next step starts
        const s = isObj(step) && ["walkTo", "turn", "speak", "playAnimation"].includes(String(step.cmd)) && step.wait === undefined ? { ...step, wait: true } : step;
        const r = await executeCommand(robot, s);
        out.push(r);
        if (!r.ok) throw new CommandError(`step ${out.length} failed: ${r.error}`);
      }
      return out;
    }
    case "parallel": {
      if (!Array.isArray(c.steps)) throw new CommandError('"steps" must be an array');
      return Promise.all(c.steps.map((s) => executeCommand(robot, s)));
    }
    case "getStatus":
      return robot.getStatus();
    default:
      throw new CommandError(`unknown command "${cmd}". Known: ${COMMAND_NAMES.join(", ")}`);
  }
}
