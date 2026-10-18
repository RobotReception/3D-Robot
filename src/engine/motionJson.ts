import { channelOf, smooth, type ClipDef, type PoseFrame } from "./clips";
import { EMOTIONS, EYE_EXPRESSIONS } from "./FaceController";
import { HAND_PRESETS, FINGERS, armPose, clampEuler, fingerPose, rawLimits, type FingerCurl, type RawPose, type Side } from "./rig";

/**
 * Data-only motion format (JSON) so tools and AI models can author animations without code.
 * See docs/MOTION_AUTHORING.md and docs/motion.schema.json (generated from MOTION_SCHEMA).
 */
export interface MotionEvent {
  /** seconds from the start of the motion */
  t: number;
  emotion?: string;
  intensity?: number;
  eyeExpression?: string | null;
  blink?: boolean;
}
export interface MotionKey {
  t: number;
  head?: { yaw?: number; pitch?: number; roll?: number };
  torso?: { yaw?: number; pitch?: number; roll?: number };
  armL?: ArmKey;
  armR?: ArmKey;
  handL?: FingerCurl | string;
  handR?: FingerCurl | string;
  /** pelvis translation in meters (x left, y up, z forward) */
  pelvis?: { x?: number; y?: number; z?: number };
  /** any bone, raw joint-space degrees [x,y,z] (see RIG.md) */
  raw?: Record<string, [number, number, number]>;
}
interface ArmKey {
  shoulder?: number; abduction?: number; twist?: number; elbow?: number; wrist?: number; wristFlex?: number; shrug?: number;
}
export interface MotionJson {
  name: string;
  description?: string;
  duration: number;
  loop?: boolean;
  /** 1..8, default 6 (see ANIMATION.md) */
  priority?: number;
  fadeIn?: number;
  fadeOut?: number;
  easing?: "smooth" | "linear";
  keys: MotionKey[];
  events?: MotionEvent[];
}

export interface Issue {
  path: string;
  message: string;
}
export interface CompileResult {
  ok: boolean;
  def?: ClipDef;
  events: MotionEvent[];
  errors: Issue[];
  warnings: Issue[];
}

const LIMITS = { maxKeys: 240, maxDuration: 30, minDuration: 0.2, maxEvents: 60, pelvis: 0.08 };
const ARM_PARAMS = ["shoulder", "abduction", "twist", "elbow", "wrist", "wristFlex", "shrug"] as const;
const AXIS3 = { head: ["yaw", "pitch", "roll"], torso: ["yaw", "pitch", "roll"] } as const;
const NAME_RE = /^[a-z][a-zA-Z0-9_-]{1,40}$/;

/** JSON Schema (draft 2020-12) to give to an LLM as structured-output / tool schema. */
export const MOTION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "RobotMotion",
  type: "object",
  required: ["name", "duration", "keys"],
  additionalProperties: false,
  properties: {
    name: { type: "string", pattern: "^[a-z][a-zA-Z0-9_-]{1,40}$", description: "unique id, e.g. 'proudWave'" },
    description: { type: "string" },
    duration: { type: "number", minimum: LIMITS.minDuration, maximum: LIMITS.maxDuration, description: "seconds" },
    loop: { type: "boolean", description: "true: first and last key must have the same values" },
    priority: { type: "integer", minimum: 1, maximum: 8, description: "3 speech gesture, 5 head, 6 emotive one-shot (default), 8 commanded gesture" },
    fadeIn: { type: "number", minimum: 0.01, maximum: 3 },
    fadeOut: { type: "number", minimum: 0.01, maximum: 3 },
    easing: { enum: ["smooth", "linear"] },
    keys: {
      type: "array", minItems: 2, maxItems: LIMITS.maxKeys,
      items: {
        type: "object", required: ["t"], additionalProperties: false,
        properties: {
          t: { type: "number", minimum: 0, description: "seconds, <= duration" },
          head: { type: "object", properties: { yaw: { type: "number", description: "+ = left, deg" }, pitch: { type: "number", description: "+ = up" }, roll: { type: "number", description: "+ = tilt left" } }, additionalProperties: false },
          torso: { type: "object", properties: { yaw: { type: "number" }, pitch: { type: "number", description: "+ = lean forward" }, roll: { type: "number", description: "+ = lean left" } }, additionalProperties: false },
          armL: { $ref: "#/$defs/arm" },
          armR: { $ref: "#/$defs/arm" },
          handL: { $ref: "#/$defs/hand" },
          handR: { $ref: "#/$defs/hand" },
          pelvis: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, additionalProperties: false, description: `meters, |v| <= ${LIMITS.pelvis}` },
          raw: { type: "object", additionalProperties: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 }, description: "bone name -> [x,y,z] raw joint-space degrees" },
        },
      },
    },
    events: {
      type: "array", maxItems: LIMITS.maxEvents,
      items: {
        type: "object", required: ["t"], additionalProperties: false,
        properties: {
          t: { type: "number", minimum: 0 }, emotion: { enum: EMOTIONS }, intensity: { type: "number", minimum: 0, maximum: 1 },
          eyeExpression: { enum: [...EYE_EXPRESSIONS, null] }, blink: { type: "boolean" },
        },
      },
    },
  },
  $defs: {
    arm: {
      type: "object", additionalProperties: false,
      properties: {
        shoulder: { type: "number", minimum: -60, maximum: 190, description: "+ = raise forward, 90 = horizontal, 180 = up" },
        abduction: { type: "number", minimum: -30, maximum: 88, description: "+ = raise sideways" },
        twist: { type: "number", minimum: -95, maximum: 95 },
        elbow: { type: "number", minimum: 0, maximum: 150, description: "flexion" },
        wrist: { type: "number", minimum: -85, maximum: 85 },
        wristFlex: { type: "number", minimum: -70, maximum: 70 },
        shrug: { type: "number", minimum: -15, maximum: 25 },
      },
    },
    hand: {
      oneOf: [
        { enum: Object.keys(HAND_PRESETS) },
        { type: "object", additionalProperties: false, properties: Object.fromEntries(FINGERS.map((f) => [f, { type: "number", minimum: 0, maximum: 1 }])) },
      ],
    },
  },
} as const;

type Track = { t: number; v: number }[];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** Validate and compile a motion. Never throws; `errors` is empty when `ok`. Angles outside the joint limits are clamped and reported as warnings. */
export function compileMotion(input: unknown, o: { existingNames?: string[]; overwrite?: boolean } = {}): CompileResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const out: CompileResult = { ok: false, events: [], errors, warnings };
  if (!isObj(input)) {
    err("$", "motion must be an object");
    return out;
  }
  const m = input as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!["name", "description", "duration", "loop", "priority", "fadeIn", "fadeOut", "easing", "keys", "events"].includes(k)) err(k, "unknown property");
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) err("name", "must match ^[a-z][a-zA-Z0-9_-]{1,40}$");
  else if (o.existingNames?.includes(m.name) && !o.overwrite) err("name", `"${m.name}" already exists (choose another name or pass overwrite)`);
  const duration = m.duration as number;
  if (!num(duration) || duration < LIMITS.minDuration || duration > LIMITS.maxDuration) err("duration", `number between ${LIMITS.minDuration} and ${LIMITS.maxDuration} seconds`);
  const priority = m.priority === undefined ? 6 : (m.priority as number);
  if (!Number.isInteger(priority) || priority < 1 || priority > 8) err("priority", "integer 1..8");
  for (const k of ["fadeIn", "fadeOut"] as const) if (m[k] !== undefined && (!num(m[k]) || (m[k] as number) < 0.01 || (m[k] as number) > 3)) err(k, "number 0.01..3");
  if (m.easing !== undefined && m.easing !== "smooth" && m.easing !== "linear") err("easing", '"smooth" or "linear"');
  if (!Array.isArray(m.keys) || m.keys.length < 2) err("keys", "array with at least 2 keys");
  else if (m.keys.length > LIMITS.maxKeys) err("keys", `at most ${LIMITS.maxKeys} keys`);
  if (errors.length) return out;

  // ---- collect per-parameter tracks
  const tracks = new Map<string, Track>();
  const add = (id: string, t: number, v: number) => {
    let tr = tracks.get(id);
    if (!tr) tracks.set(id, (tr = []));
    tr.push({ t, v });
  };
  const keys = [...(m.keys as unknown[])].map((k, i) => ({ k, i }));
  for (const { k, i } of keys) {
    const p = `keys[${i}]`;
    if (!isObj(k) || !num(k.t)) {
      err(p, "key must be an object with numeric t");
      continue;
    }
    if ((k.t as number) < 0 || (k.t as number) > duration + 1e-6) err(`${p}.t`, `must be within 0..${duration}`);
    for (const prop of Object.keys(k)) if (!["t", "head", "torso", "armL", "armR", "handL", "handR", "pelvis", "raw"].includes(prop)) err(`${p}.${prop}`, "unknown property");
    const t = k.t as number;
    for (const grp of ["head", "torso"] as const) {
      const g = k[grp];
      if (g === undefined) continue;
      if (!isObj(g)) { err(`${p}.${grp}`, "object {yaw,pitch,roll}"); continue; }
      for (const [a, v] of Object.entries(g)) {
        if (!(AXIS3[grp] as readonly string[]).includes(a)) err(`${p}.${grp}.${a}`, "unknown axis (yaw, pitch, roll)");
        else if (!num(v)) err(`${p}.${grp}.${a}`, "number (degrees)");
        else add(`${grp}.${a}`, t, v as number);
      }
    }
    for (const side of ["L", "R"] as const) {
      const a = k[`arm${side}`];
      if (a !== undefined) {
        if (!isObj(a)) { err(`${p}.arm${side}`, "object"); continue; }
        for (const [n, v] of Object.entries(a)) {
          if (!(ARM_PARAMS as readonly string[]).includes(n)) err(`${p}.arm${side}.${n}`, `unknown parameter (${ARM_PARAMS.join(", ")})`);
          else if (!num(v)) err(`${p}.arm${side}.${n}`, "number (degrees)");
          else add(`arm${side}.${n}`, t, v as number);
        }
      }
      const h = k[`hand${side}`];
      if (h !== undefined) {
        const curl: FingerCurl | undefined = typeof h === "string" ? HAND_PRESETS[h] : isObj(h) ? (h as FingerCurl) : undefined;
        if (!curl) { err(`${p}.hand${side}`, `preset (${Object.keys(HAND_PRESETS).join(", ")}) or {thumb,index,middle,ring: 0..1}`); continue; }
        for (const [f, v] of Object.entries(curl)) {
          if (!(FINGERS as readonly string[]).includes(f)) err(`${p}.hand${side}.${f}`, "unknown finger");
          else if (!num(v) || (v as number) < 0 || (v as number) > 1) err(`${p}.hand${side}.${f}`, "number 0..1");
          else add(`hand${side}.${f}`, t, v as number);
        }
      }
    }
    if (k.pelvis !== undefined) {
      if (!isObj(k.pelvis)) err(`${p}.pelvis`, "object {x,y,z} in meters");
      else for (const [a, v] of Object.entries(k.pelvis)) {
        if (!["x", "y", "z"].includes(a) || !num(v)) err(`${p}.pelvis.${a}`, "x|y|z number (meters)");
        else {
          if (Math.abs(v as number) > LIMITS.pelvis) warnings.push({ path: `${p}.pelvis.${a}`, message: `clamped to ±${LIMITS.pelvis} m` });
          add(`pelvis.${a}`, t, Math.max(-LIMITS.pelvis, Math.min(LIMITS.pelvis, v as number)));
        }
      }
    }
    if (k.raw !== undefined) {
      if (!isObj(k.raw)) err(`${p}.raw`, "object bone -> [x,y,z]");
      else for (const [bone, e] of Object.entries(k.raw)) {
        if (!channelOf(bone) || !Array.isArray(e) || e.length !== 3 || !e.every(num)) err(`${p}.raw.${bone}`, "bone of head/torso/arm/finger channels with [x,y,z] degrees (legs are driven by locomotion IK)");
        else (e as number[]).forEach((v, ax) => add(`raw.${bone}.${ax}`, t, v));
      }
    }
  }
  if (errors.length) return out;
  if (!tracks.size) {
    err("keys", "no animated values found");
    return out;
  }

  // ---- events
  const events: MotionEvent[] = [];
  if (m.events !== undefined) {
    if (!Array.isArray(m.events) || m.events.length > LIMITS.maxEvents) err("events", `array of at most ${LIMITS.maxEvents}`);
    else m.events.forEach((e, i) => {
      if (!isObj(e) || !num(e.t) || (e.t as number) < 0 || (e.t as number) > duration) return err(`events[${i}]`, `object with t in 0..${duration}`);
      if (e.emotion !== undefined && !EMOTIONS.includes(e.emotion as never)) err(`events[${i}].emotion`, `one of ${EMOTIONS.join(", ")}`);
      if (e.eyeExpression != null && !EYE_EXPRESSIONS.includes(e.eyeExpression as never)) err(`events[${i}].eyeExpression`, `one of ${EYE_EXPRESSIONS.join(", ")}`);
      events.push(e as unknown as MotionEvent);
    });
  }
  if (errors.length) return out;

  // ---- sampling function
  const linear = m.easing === "linear";
  for (const tr of tracks.values()) tr.sort((a, b) => a.t - b.t);
  const valueAt = (tr: Track, t: number) => {
    // before the first key the value eases from rest (0) at t=0; after the last key it holds
    if (t >= tr[tr.length - 1].t) return tr[tr.length - 1].v;
    let prev: { t: number; v: number } = { t: 0, v: 0 };
    for (const k of tr) {
      if (t <= k.t) {
        const span = k.t - prev.t;
        if (span <= 1e-9) return k.v;
        const u = (t - prev.t) / span;
        return prev.v + (k.v - prev.v) * (linear ? u : smooth(u));
      }
      prev = k;
    }
    return prev.v;
  };

  if (m.loop === true) {
    for (const [id, tr] of tracks) {
      const first = tr[0];
      const last = tr[tr.length - 1];
      if (first.t > 1e-6 || Math.abs(last.t - duration) > 1e-6 || Math.abs(first.v - last.v) > 0.5) {
        warnings.push({ path: id, message: "loop: first key should be at t=0 and last at t=duration with equal values, otherwise the loop pops" });
      }
    }
  }

  let clampedBones = new Set<string>();
  const sample = (t: number): PoseFrame => {
    const g = (id: string) => { const tr = tracks.get(id); return tr ? valueAt(tr, t) : undefined; };
    const joints: RawPose = {};
    const set = (bone: string, e: [number, number, number]) => {
      const c = clampEuler(bone, { x: e[0], y: e[1], z: e[2] });
      if (c.x !== e[0] || c.y !== e[1] || c.z !== e[2]) clampedBones.add(bone);
      joints[bone] = [c.x, c.y, c.z]; // later sources (raw) override earlier ones for the same bone
    };
    if ([...tracks.keys()].some((k) => k.startsWith("head."))) {
      const yaw = g("head.yaw") ?? 0, pitch = g("head.pitch") ?? 0, roll = g("head.roll") ?? 0;
      set("head", [-pitch * 0.65, yaw * 0.65, -roll * 0.65]);
      set("neck", [-pitch * 0.35, yaw * 0.35, -roll * 0.35]);
    }
    if ([...tracks.keys()].some((k) => k.startsWith("torso."))) {
      const yaw = g("torso.yaw") ?? 0, pitch = g("torso.pitch") ?? 0, roll = g("torso.roll") ?? 0;
      set("spine", [pitch * 0.55, yaw * 0.55, -roll * 0.55]);
      set("chest", [pitch * 0.45, yaw * 0.45, -roll * 0.45]);
    }
    for (const side of ["L", "R"] as Side[]) {
      if ([...tracks.keys()].some((k) => k.startsWith(`arm${side}.`))) {
        const a: Record<string, number | undefined> = {};
        for (const n of ARM_PARAMS) a[n] = g(`arm${side}.${n}`);
        const pose = armPose(side, a as never);
        for (const [b, e] of Object.entries(pose)) set(b, e);
        if (a.shrug !== undefined) set(`clavicle_${side}`, [0, 0, (side === "R" ? -1 : 1) * a.shrug]);
      }
      if ([...tracks.keys()].some((k) => k.startsWith(`hand${side}.`))) {
        const curl: FingerCurl = {};
        for (const f of FINGERS) { const v = g(`hand${side}.${f}`); curl[f] = v === undefined ? 0 : v; }
        for (const [b, e] of Object.entries(fingerPose(side, curl))) set(b, e);
      }
    }
    const rawBones = new Map<string, [number, number, number]>();
    for (const id of tracks.keys()) {
      if (!id.startsWith("raw.")) continue;
      const [, bone, ax] = id.split(".");
      const e = rawBones.get(bone) ?? [0, 0, 0];
      e[+ax] = g(id)!;
      rawBones.set(bone, e);
    }
    for (const [b, e] of rawBones) set(b, e);
    const f: PoseFrame = { joints };
    if ([...tracks.keys()].some((k) => k.startsWith("pelvis."))) f.pelvis = [g("pelvis.x") ?? 0, g("pelvis.y") ?? 0, g("pelvis.z") ?? 0];
    return f;
  };
  // report clamping once, over the whole timeline
  const n = Math.ceil(duration * 20);
  for (let i = 0; i <= n; i++) sample((i / n) * duration);
  for (const b of clampedBones) warnings.push({ path: `joint ${b}`, message: `values exceeded the natural range ${JSON.stringify(rawLimits(b))} and are clamped` });
  clampedBones = new Set();

  out.def = {
    name: m.name as string,
    description: (m.description as string) ?? "",
    duration,
    loop: m.loop === true,
    priority,
    fadeIn: m.fadeIn as number | undefined,
    fadeOut: m.fadeOut as number | undefined,
    pose: (t) => sample(Math.min(duration, Math.max(0, t))),
  };
  out.events = events;
  out.ok = true;
  return out;
}

/** Sample any ClipDef into the JSON format (raw joint-space keys) so it can be inspected, edited or used as an AI example. */
export function exportMotion(def: ClipDef, maxKeys = 60): MotionJson {
  const step = Math.max(0.1, def.duration / maxKeys);
  const times: number[] = [];
  for (let t = 0; t < def.duration - 1e-6; t += step) times.push(+t.toFixed(3));
  times.push(def.duration);
  const frames = times.map((t) => def.pose(t, t / def.duration));
  const bones = new Set<string>();
  let usesPelvis = false;
  for (const f of frames) {
    for (const [b, e] of Object.entries(f.joints ?? {})) if (e.some((v) => Math.abs(v) > 0.05)) bones.add(b);
    if (f.pelvis && f.pelvis.some((v) => Math.abs(v) > 1e-4)) usesPelvis = true;
  }
  const r = (v: number) => +v.toFixed(2);
  const keys: MotionKey[] = frames.map((f, i) => {
    const raw: Record<string, [number, number, number]> = {};
    for (const b of bones) {
      const e = f.joints?.[b] ?? [0, 0, 0];
      raw[b] = [r(e[0]), r(e[1]), r(e[2])];
    }
    const k: MotionKey = { t: times[i], raw };
    if (usesPelvis) k.pelvis = { x: +(f.pelvis?.[0] ?? 0).toFixed(4), y: +(f.pelvis?.[1] ?? 0).toFixed(4), z: +(f.pelvis?.[2] ?? 0).toFixed(4) };
    return k;
  });
  return { name: def.name, description: def.description, duration: def.duration, loop: def.loop, priority: def.priority, keys };
}
