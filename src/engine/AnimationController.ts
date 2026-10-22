import * as THREE from "three";
import { CHANNELS, bakeClip, channelBones, type Channel, type ClipDef } from "./clips";
import type { JointSpace } from "./rig";

export interface PlayOptions {
  /** override the clip priority */
  priority?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** playback speed multiplier for this play */
  speed?: number;
  loop?: boolean;
  /** restrict to some channels (e.g. only "armR") */
  channels?: Channel[];
  /** take the channel even if a higher-priority entry owns it */
  force?: boolean;
}
export interface PlayResult {
  name: string;
  accepted: Channel[];
  rejected: Channel[];
}

interface Entry {
  id: number;
  name: string;
  channel: Channel;
  priority: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
  action: THREE.AnimationAction;
  weight: number;
  ending: boolean;
  duration: number;
}

type Listener = (type: "play" | "end" | "blocked", info: { name: string; channel?: Channel; channels?: Channel[] }) => void;

/**
 * Channel-layered animation: each channel keeps a priority stack of looping/one-shot
 * clips. The highest-priority entry owns the channel; lower loops are paused underneath
 * and resume when it ends. Ownership changes crossfade through normalised weights, and
 * everything is evaluated by a single THREE.AnimationMixer.
 */
export class AnimationController {
  readonly mixer: THREE.AnimationMixer;
  /**
   * The mixer animates a hidden "pose proxy" (same bone names, flat hierarchy) and we copy the
   * result onto the real bones every frame. Reason: AnimationMixer only writes a property when
   * its blended value *changed* since the last frame, so held poses would never overwrite the
   * additive layers (gaze, IK, overrides) that modify the real bones after the mixer.
   */
  private proxy = new THREE.Group();
  private proxyBones = new Map<string, THREE.Object3D>();
  private defs = new Map<string, ClipDef>();
  private baked = new Map<string, Map<Channel, THREE.AnimationClip>>();
  private stacks = new Map<Channel, Entry[]>();
  private nextId = 1;
  /** global time scale (Control Studio "speed") */
  speed = 1;
  onEvent?: Listener;

  constructor(private joints: JointSpace, _root?: THREE.Object3D) {
    void _root;
    for (const list of Object.values(channelBones())) {
      for (const name of list) {
        if (!joints.has(name)) continue;
        const o = new THREE.Object3D();
        o.name = name;
        o.quaternion.copy(joints.bone(name).quaternion);
        o.position.copy(joints.bone(name).position);
        this.proxy.add(o);
        this.proxyBones.set(name, o);
      }
    }
    this.mixer = new THREE.AnimationMixer(this.proxy);
    for (const c of CHANNELS) this.stacks.set(c, []);
  }

  register(def: ClipDef) {
    this.defs.set(def.name, def);
    this.baked.delete(def.name);
  }
  registerAll(defs: ClipDef[]) {
    defs.forEach((d) => this.register(d));
  }
  has(name: string) {
    return this.defs.has(name);
  }
  list(): ClipDef[] {
    return [...this.defs.values()];
  }
  def(name: string) {
    return this.defs.get(name);
  }

  private clipsFor(name: string) {
    let b = this.baked.get(name);
    if (!b) {
      b = bakeClip(this.defs.get(name)!, this.joints);
      this.baked.set(name, b);
    }
    return b;
  }

  play(name: string, o: PlayOptions = {}): PlayResult {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Unknown animation "${name}"`);
    const priority = o.priority ?? def.priority;
    const loop = o.loop ?? def.loop;
    const clips = this.clipsFor(name);
    const accepted: Channel[] = [];
    const rejected: Channel[] = [];
    for (const [channel, clip] of clips) {
      if (o.channels && !o.channels.includes(channel)) continue;
      const stack = this.stacks.get(channel)!;
      const owner = this.topOf(stack);
      if (owner && !o.force && owner.priority > priority && owner.name !== name) {
        rejected.push(channel);
        continue;
      }
      // same name already playing here: restart it
      for (const e of stack) if (e.name === name) this.end(e, true);
      // entries of equal-or-lower priority that are one-shots become stale; loops stay underneath
      for (const e of stack) if (!e.ending && !e.loop && e.priority <= priority) this.end(e, false);
      for (const e of stack) if (!e.ending && e.loop && e.priority === priority && priority > 0) this.end(e, false);
      const action = this.mixer.clipAction(clip);
      action.reset();
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      action.clampWhenFinished = true;
      action.setEffectiveWeight(0);
      action.setEffectiveTimeScale(o.speed ?? 1);
      action.enabled = true;
      action.play();
      stack.push({
        id: this.nextId++, name, channel, priority, loop,
        fadeIn: Math.max(0.01, o.fadeIn ?? def.fadeIn ?? 0.35),
        fadeOut: Math.max(0.01, o.fadeOut ?? def.fadeOut ?? 0.35),
        action, weight: 0, ending: false, duration: def.duration,
      });
      accepted.push(channel);
    }
    if (accepted.length) this.onEvent?.("play", { name, channels: accepted });
    if (rejected.length) this.onEvent?.("blocked", { name, channels: rejected });
    return { name, accepted, rejected };
  }

  /** Stop a clip by name (fades out), or everything above the idle base when omitted. */
  stop(name?: string, fade?: number) {
    for (const stack of this.stacks.values()) {
      for (const e of stack) {
        if (e.priority === 0 && e.name === "idle") continue;
        if (!name || e.name === name) this.end(e, false, fade);
      }
    }
  }

  /** Playing clip names per channel (top first). */
  active(): Record<Channel, string[]> {
    const out = {} as Record<Channel, string[]>;
    for (const [c, stack] of this.stacks) out[c] = stack.filter((e) => !e.ending).map((e) => e.name).reverse();
    return out;
  }
  ownerOf(channel: Channel): { name: string; priority: number } | null {
    const t = this.topOf(this.stacks.get(channel)!);
    return t ? { name: t.name, priority: t.priority } : null;
  }
  isPlaying(name: string) {
    for (const stack of this.stacks.values()) if (stack.some((e) => e.name === name && !e.ending)) return true;
    return false;
  }

  private topOf(stack: Entry[]): Entry | null {
    let best: Entry | null = null;
    for (const e of stack) {
      if (e.ending) continue;
      if (!best || e.priority >= best.priority) best = e;
    }
    return best;
  }

  private end(e: Entry, immediate: boolean, fade?: number) {
    if (e.ending) return;
    e.ending = true;
    if (fade !== undefined) e.fadeOut = Math.max(0.01, fade);
    if (immediate) e.weight = 0;
    this.onEvent?.("end", { name: e.name, channel: e.channel });
  }

  update(dt: number) {
    for (const stack of this.stacks.values()) {
      const top = this.topOf(stack);
      let sum = 0;
      for (const e of stack) {
        // one-shot finished?
        if (!e.loop && !e.ending && e.action.time >= e.duration - 1e-3) {
          this.end(e, false);
        }
        const target = !e.ending && e === top ? 1 : 0;
        const rate = target === 1 ? 1 / e.fadeIn : 1 / e.fadeOut;
        e.weight += Math.sign(target - e.weight) * Math.min(Math.abs(target - e.weight), rate * dt);
        sum += e.weight;
      }
      for (const e of stack) {
        const w = sum > 1e-5 ? e.weight / sum : 0;
        e.action.setEffectiveWeight(w);
        e.action.paused = false;
      }
      // drop finished entries
      for (let i = stack.length - 1; i >= 0; i--) {
        const e = stack[i];
        if (e.ending && e.weight <= 1e-4) {
          // a restarted clip reuses the same cached action: only stop it if no live entry still uses it
          if (!stack.some((o) => o !== e && o.action === e.action)) e.action.stop();
          stack.splice(i, 1);
        }
      }
    }
    this.mixer.update(dt * this.speed);
    // publish the blended pose onto the real skeleton (always, see `proxy`)
    for (const [name, o] of this.proxyBones) {
      const b = this.joints.bone(name);
      b.quaternion.copy(o.quaternion);
      if (name === "pelvis") b.position.copy(o.position);
    }
  }

  /** Immediately drop everything except the idle base (used by resetPose). */
  clear() {
    for (const stack of this.stacks.values()) {
      for (const e of stack) if (!(e.priority === 0 && e.name === "idle")) this.end(e, true);
    }
  }

  dispose() {
    for (const stack of this.stacks.values()) for (const e of stack) this.end(e, true);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.proxy);
    this.baked.clear();
    for (const s of this.stacks.values()) s.length = 0;
  }
}
