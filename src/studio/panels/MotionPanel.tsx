import { useState } from "react";
import { EMOTIONS, EYE_EXPRESSIONS, type EmotionName, type EyeExpression } from "../../engine/FaceController";
import { ASSISTANT_STATES } from "../../engine/stateMachine";
import { HAND_PRESETS } from "../../engine/rig";
import { useCoreChange, useStudio, useTick } from "../StudioContext";
import { Chip, Row, Section, Slider } from "../ui";

const HIDDEN = new Set(["talkR", "talkL"]);

export function MotionPanel() {
  const { core, t } = useStudio();
  useTick(5);
  useCoreChange();
  const r = core.robot;
  const status = r.getStatus();
  const [loop, setLoop] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [wx, setWx] = useState(1.5);
  const [wz, setWz] = useState(2);
  const [eye, setEye] = useState<EyeExpression | "auto">("auto");
  const anims = r.listAnimations().filter((n) => !HIDDEN.has(n));

  return (
    <>
      <Section title={t("Assistant state")}>
        <Row>
          {ASSISTANT_STATES.map((s) => (
            <Chip key={s} active={status.state === s} onClick={() => r.setState(s)} tone={s === "error" ? "danger" : undefined}>
              {t(s[0].toUpperCase() + s.slice(1))}
            </Chip>
          ))}
        </Row>
      </Section>

      <Section title={t("Animations")} right={<label className="inline"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />{t("Loop looping clips")}</label>}>
        <div className="grid3">
          {anims.map((n) => (
            <Chip key={n} active={Object.values(status.animations).some((a) => a[0] === n)} onClick={() => r.playAnimation(n, loop ? { loop: true } : {})} testId={`anim-${n}`}>
              {n}
            </Chip>
          ))}
        </div>
        <Row>
          <Chip onClick={() => r.stop()} tone="danger">{t("Stop")}</Chip>
          <Chip onClick={() => { r.resetPose(); setEye("auto"); setSpeed(1); }}>{t("Reset pose")}</Chip>
        </Row>
        <Slider label={t("Speed")} value={speed} min={0.2} max={2.5} step={0.05} unit="×" onChange={(v) => { setSpeed(v); r.setSpeed(v); }} />
        <div className="active-list">
          {Object.entries(status.animations).map(([c, a]) => (
            <span key={c} className="tag">{c}: <b>{a[0]}</b></span>
          ))}
        </div>
      </Section>

      <Section title={t("Emotion")}>
        <Row>
          {EMOTIONS.map((e) => (
            <Chip key={e} testId={`emo-${e}`} active={status.emotion.name === e} onClick={() => r.setEmotion(e as EmotionName)}>
              {t(e[0].toUpperCase() + e.slice(1))}
            </Chip>
          ))}
        </Row>
        <h4>{t("Eye expression")}</h4>
        <Row>
          <Chip testId="eye-auto" active={eye === "auto"} onClick={() => { setEye("auto"); r.setEyeExpression(null); }}>{t("Auto (emotion)")}</Chip>
          {EYE_EXPRESSIONS.map((e) => (
            <Chip key={e} testId={`eye-${e}`} active={eye === e} onClick={() => { setEye(e); r.setEyeExpression(e); }}>{e}</Chip>
          ))}
        </Row>
      </Section>

      <Section title={t("Walk")}>
        <Row>
          <label className="num">x<input type="number" step="0.5" value={wx} onChange={(e) => setWx(+e.target.value)} /></label>
          <label className="num">z<input type="number" step="0.5" value={wz} onChange={(e) => setWz(+e.target.value)} /></label>
          <Chip onClick={() => void r.walkTo({ x: wx, z: wz })} testId="walk-go">{t("Go")}</Chip>
          <Chip onClick={() => void r.walkTo({ x: 0, z: 0 }, { facing: 0 })}>0,0</Chip>
        </Row>
        <Row>
          <Chip onClick={() => void r.turnBy(90)}>{t("Turn left")}</Chip>
          <Chip onClick={() => void r.turnBy(-90)}>{t("Turn right")}</Chip>
          <Chip onClick={() => r.locomotion.walkForward(0.7)}>{t("Walking")}</Chip>
          <Chip onClick={() => r.locomotion.stop()}>{t("Stop")}</Chip>
        </Row>
        <p className="hint">
          pos ({status.locomotion.x}, {status.locomotion.z}) · yaw {status.locomotion.yawDeg}° · {status.locomotion.state}
        </p>
      </Section>

      <Section title={t("Gaze")}>
        <Row>
          {(["free", "cursor", "camera"] as const).map((m) => (
            <Chip key={m} active={core.gazeMode === m} onClick={() => core.setGazeMode(m)}>
              {m === "free" ? t("Free gaze") : m === "cursor" ? t("Follow cursor") : t("Look at camera")}
            </Chip>
          ))}
        </Row>
      </Section>

      <Section title={t("Hands")}>
        <Row>
          {Object.keys(HAND_PRESETS).map((p) => (
            <Chip key={p} onClick={() => { r.setHand("left", p as keyof typeof HAND_PRESETS); r.setHand("right", p as keyof typeof HAND_PRESETS); }}>{p}</Chip>
          ))}
          <Chip onClick={() => { r.releaseHand("left"); r.releaseHand("right"); }}>{t("Release all")}</Chip>
        </Row>
        <h4>{t("Pointing")}</h4>
        <Row>
          <Chip onClick={() => r.pointAt({ x: 1.2, y: 1.3, z: 1.2 }, { hand: "left", hold: 3 })}>{t("Left")}</Chip>
          <Chip onClick={() => r.pointAt({ x: -1.2, y: 1.3, z: 1.2 }, { hand: "right", hold: 3 })}>{t("Right")}</Chip>
          <Chip onClick={() => r.pointAt({ x: -0.4, y: 2.2, z: 0.8 }, { hand: "right", hold: 3 })}>{t("Up")}</Chip>
        </Row>
      </Section>
    </>
  );
}
