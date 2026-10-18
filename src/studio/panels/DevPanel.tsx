import { useRef, useState } from "react";
import { connectWebSocket } from "../../engine/bridge";
import { executeMessage } from "../../engine/commands";
import { useCoreChange, useStudio, useTick } from "../StudioContext";
import { Chip, Row, Section } from "../ui";

const EXAMPLES: Record<string, unknown> = {
  "greet + emotion": { cmd: "sequence", steps: [{ cmd: "setEmotion", emotion: "happy" }, { cmd: "playAnimation", name: "greeting" }, { cmd: "speak", text: "Hello!", tts: false }] },
  "head + arm": { cmd: "parallel", steps: [{ cmd: "moveHead", yaw: 25, pitch: 10 }, { cmd: "moveArm", side: "right", shoulder: 60, elbow: 40 }] },
  "walk & turn": { cmd: "sequence", steps: [{ cmd: "walkTo", x: 1, z: 1.5 }, { cmd: "turn", to: 180 }, { cmd: "walkTo", x: 0, z: 0, facing: 0 }] },
  "point": { cmd: "pointAt", target: { x: -1, y: 1.3, z: 1 }, hold: 3 },
  "lookAt": { cmd: "lookAt", target: { x: 1.5, y: 1.4, z: 1.5 } },
  "set state": { cmd: "setState", state: "thinking" },
  "status": { cmd: "getStatus" },
  "invalid (error demo)": { cmd: "setEmotion", emotion: "ecstatic" },
};

export function DevPanel() {
  const { core, t } = useStudio();
  useTick(4);
  useCoreChange();
  const r = core.robot;
  const v = core.viewer;
  const st = v.stats;
  const [json, setJson] = useState(JSON.stringify(EXAMPLES["greet + emotion"], null, 2));
  const [reply, setReply] = useState("");
  const [ws, setWs] = useState("ws://localhost:8787");
  const [wsState, setWsState] = useState("");
  const sock = useRef<{ close(): void } | null>(null);
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;

  const send = async () => {
    const res = await executeMessage(r, json);
    setReply(JSON.stringify(res, null, 2));
  };

  return (
    <>
      <Section title={t("Performance")}>
        <div className="stats" data-testid="stats">
          <div><b>{st.fps}</b><span>FPS</span></div>
          <div><b>{st.frameMs}</b><span>ms render</span></div>
          <div><b>{core.engineMs.toFixed(2)}</b><span>ms {t("Engine update")}</span></div>
          <div><b>{st.calls}</b><span>{t("Draw calls")}</span></div>
          <div><b>{(st.triangles / 1000).toFixed(1)}k</b><span>{t("Triangles")}</span></div>
          <div><b>{st.geometries}/{st.textures}</b><span>geo/tex</span></div>
          <div><b>{st.pixelRatio}</b><span>pixel ratio</span></div>
          <div><b>{heap ? (heap / 1048576).toFixed(0) + " MB" : "n/a"}</b><span>JS heap</span></div>
        </div>
      </Section>

      <Section title={t("JSON command")}>
        <Row>
          <select onChange={(e) => e.target.value && setJson(JSON.stringify(EXAMPLES[e.target.value], null, 2))} defaultValue="">
            <option value="">{t("Examples")}…</option>
            {Object.keys(EXAMPLES).map((k) => <option key={k}>{k}</option>)}
          </select>
          <Chip onClick={() => void send()} testId="json-send">{t("Send")}</Chip>
        </Row>
        <textarea className="code" rows={8} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} dir="ltr" data-testid="json-input" />
        <pre className="code out" data-testid="json-reply">{reply}</pre>
      </Section>

      <Section title="WebSocket bridge">
        <p className="hint">Server → robot: JSON commands. Robot → server: results + events.</p>
        <Row>
          <input value={ws} onChange={(e) => setWs(e.target.value)} dir="ltr" aria-label={t("WebSocket URL")} />
          {sock.current ? (
            <Chip tone="danger" onClick={() => { sock.current?.close(); sock.current = null; setWsState(""); }}>{t("Disconnect")}</Chip>
          ) : (
            <Chip onClick={() => { sock.current = connectWebSocket(r, ws, { onStatus: setWsState }); setWsState("…"); }}>{t("Connect")}</Chip>
          )}
          <span className="tag">{wsState}</span>
        </Row>
      </Section>

      <Section title={t("Robot status")}>
        <pre className="code out" data-testid="status">{JSON.stringify(r.getStatus(), null, 1)}</pre>
      </Section>

      <Section title={t("Events")} right={<Chip onClick={() => { core.log.length = 0; }}>{t("Clear")}</Chip>}>
        <div className="log" data-testid="event-log">
          {[...core.log].reverse().slice(0, 60).map((e, i) => (
            <div key={i}><b>{e.type}</b> <span>{JSON.stringify(e.data)}</span></div>
          ))}
        </div>
      </Section>
    </>
  );
}
