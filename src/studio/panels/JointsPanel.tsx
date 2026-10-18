import { useEffect, useState } from "react";
import { FINGERS, rawLimits, type Side } from "../../engine/rig";
import { useCoreChange, useStudio, useTick } from "../StudioContext";
import { Chip, Row, Section, Slider } from "../ui";

export function JointsPanel() {
  const { core, t } = useStudio();
  useTick(8);
  useCoreChange();
  const r = core.robot;
  const joints = r.listJoints();
  const bone = core.selectedBone ?? "head";
  const info = r.getJointAngles(bone);
  const lim = rawLimits(bone);
  const [, setSeed] = useState(0);
  useEffect(() => {
    core.onBoneSelected = () => setSeed((n) => n + 1);
    return () => {
      core.onBoneSelected = undefined;
    };
  }, [core]);

  const target = r.overrides.getTarget(bone);
  const axes = ["x", "y", "z"] as const;
  const axisName: Record<string, string> = { x: "X (pitch/flex)", y: "Y (yaw/twist)", z: "Z (roll/abduct)" };

  const head = r.joints.currentEuler("head");
  const neck = r.joints.currentEuler("neck");
  const headYaw = head.y + neck.y;
  const headPitch = -(head.x + neck.x);
  const headRoll = -(head.z + neck.z);

  return (
    <>
      <Section title={t("Selected joint")} right={<span className="tag">{core.jointLabel(bone)} · <code>{bone}</code></span>}>
        <p className="hint">{t("Click the robot to pick a joint")}</p>
        <select value={bone} onChange={(e) => core.selectBone(e.target.value)} data-testid="joint-select">
          {joints.map((j) => <option key={j.bone} value={j.bone}>{j.label} ({j.bone})</option>)}
        </select>
        {axes.map((a) => {
          const [lo, hi] = lim[a];
          const locked = lo === hi;
          const val = target && target[a] !== undefined ? target[a]! : info.angles[a];
          return (
            <Slider
              key={a} label={axisName[a]} min={lo} max={hi || lo + 1} step={0.5} value={Math.max(lo, Math.min(hi, val))}
              disabled={locked} readout={`${info.angles[a].toFixed(1)} (${lo}…${hi})`} unit="°" testId={`joint-${a}`}
              onChange={(v) => r.moveJoint(bone, { [a]: v }, { smooth: 0.03, fade: 0.15 })}
            />
          );
        })}
        <Row>
          <Chip onClick={() => r.releaseJoint(bone)}>{t("Release joint")}</Chip>
          <Chip onClick={() => r.releaseJoint()} tone="danger">{t("Release all")}</Chip>
          <span className={`tag ${info.overridden ? "warn" : ""}`}>{info.overridden ? t("Override") : "anim"}</span>
        </Row>
      </Section>

      <Section title={t("Head & eyes")}>
        <Slider label={t("Yaw")} min={-85} max={85} value={Math.round(headYaw)} onChange={(v) => r.moveHead({ yaw: v }, { smooth: 0.03 })} testId="head-yaw" />
        <Slider label={t("Pitch")} min={-50} max={50} value={Math.round(headPitch)} onChange={(v) => r.moveHead({ pitch: v }, { smooth: 0.03 })} testId="head-pitch" />
        <Slider label={t("Roll")} min={-45} max={45} value={Math.round(headRoll)} onChange={(v) => r.moveHead({ roll: v }, { smooth: 0.03 })} testId="head-roll" />
        <Slider label={t("Eyes yaw")} min={-26} max={26} value={r.gaze.manualEyes.L?.yaw ?? 0} onChange={(v) => r.setEyeDirection({ yaw: v, pitch: r.gaze.manualEyes.L?.pitch ?? 0 })} />
        <Slider label={t("Eyes pitch")} min={-19} max={19} value={r.gaze.manualEyes.L?.pitch ?? 0} onChange={(v) => r.setEyeDirection({ yaw: r.gaze.manualEyes.L?.yaw ?? 0, pitch: v })} />
        <Slider label={t("Mouth open")} min={0} max={1} step={0.01} unit="" value={r.face.mouthOpenValue} onChange={(v) => r.setMouthOpen(v)} testId="mouth-open" />
        <Row>
          <Chip onClick={() => r.blink()}>{t("Blink")}</Chip>
          <Chip onClick={() => r.blink("left")} testId="wink-left">{t("Wink L")}</Chip>
          <Chip onClick={() => r.blink("right")}>{t("Wink R")}</Chip>
          <Chip onClick={() => { r.setEyeDirection(null); r.setMouthOpen(null); r.releaseJoint("head"); r.releaseJoint("neck"); }}>{t("Release all")}</Chip>
        </Row>
      </Section>

      <Section title={t("Torso")}>
        <Slider label={t("Yaw")} min={-60} max={60} value={Math.round(r.joints.currentEuler("spine").y + r.joints.currentEuler("chest").y)} onChange={(v) => r.moveTorso({ yaw: v }, { smooth: 0.03 })} testId="torso-yaw" />
        <Slider label={t("Lean")} min={-30} max={45} value={Math.round(r.joints.currentEuler("spine").x + r.joints.currentEuler("chest").x)} onChange={(v) => r.moveTorso({ pitch: v }, { smooth: 0.03 })} testId="torso-pitch" />
        <Slider label={t("Roll")} min={-25} max={25} value={Math.round(-(r.joints.currentEuler("spine").z + r.joints.currentEuler("chest").z))} onChange={(v) => r.moveTorso({ roll: v }, { smooth: 0.03 })} />
        <Row><Chip onClick={() => { r.releaseJoint("spine"); r.releaseJoint("chest"); }}>{t("Release joint")}</Chip></Row>
      </Section>

      {(["left", "right"] as const).map((side) => {
        const s: Side = side === "left" ? "L" : "R";
        const up = r.joints.currentEuler(`upperarm_${s}`);
        const fa = r.joints.currentEuler(`forearm_${s}`);
        const hd = r.joints.currentEuler(`hand_${s}`);
        const m = s === "R" ? -1 : 1;
        return (
          <Section key={side} title={t(side === "left" ? "Left arm" : "Right arm")}>
            <Slider label={t("Shoulder")} min={-190} max={60} value={Math.round(-up.x)} onChange={(v) => r.moveArm(side, { shoulder: v }, { smooth: 0.03 })} testId={`arm-${s}-shoulder`} />
            <Slider label={t("Abduction")} min={-30} max={88} value={Math.round(m * up.z)} onChange={(v) => r.moveArm(side, { abduction: v }, { smooth: 0.03 })} />
            <Slider label={t("Twist")} min={-95} max={95} value={Math.round(m * up.y)} onChange={(v) => r.moveArm(side, { twist: v }, { smooth: 0.03 })} />
            <Slider label={t("Elbow")} min={0} max={150} value={Math.round(-fa.x)} onChange={(v) => r.moveArm(side, { elbow: v }, { smooth: 0.03 })} testId={`arm-${s}-elbow`} />
            <Slider label={t("Wrist")} min={-85} max={85} value={Math.round(m * fa.y)} onChange={(v) => r.moveArm(side, { wrist: v }, { smooth: 0.03 })} />
            <Slider label={t("Wrist flex")} min={-70} max={70} value={Math.round(-hd.x)} onChange={(v) => r.moveArm(side, { wristFlex: v }, { smooth: 0.03 })} />
            <Slider label={t("Shrug")} min={-15} max={25} value={Math.round(m * r.joints.currentEuler(`clavicle_${s}`).z)} onChange={(v) => r.moveArm(side, { shrug: v }, { smooth: 0.03 })} />
            <h4>{t("Fingers")}</h4>
            {FINGERS.map((f) => (
              <Slider key={f} label={t(f[0].toUpperCase() + f.slice(1))} min={0} max={1} step={0.01} unit=""
                value={Math.min(1, Math.abs(r.joints.currentEuler(`finger_${f}_1_${s}`).z) / (f === "thumb" ? 65 : 85))}
                onChange={(v) => r.setHand(side, { [f]: v })} />
            ))}
          </Section>
        );
      })}
    </>
  );
}
