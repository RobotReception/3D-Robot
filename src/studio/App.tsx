import { useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundPreset, CameraPreset, QualityLevel } from "../viewer/RobotViewer";
import { StudioCore, type Style } from "./core";
import { makeT, type Lang } from "./i18n";
import { AudioPanel } from "./panels/AudioPanel";
import { BrandPanel } from "./panels/BrandPanel";
import { DevPanel } from "./panels/DevPanel";
import { JointsPanel } from "./panels/JointsPanel";
import { MotionPanel } from "./panels/MotionPanel";
import { StudioCtx, useCoreChange, useLocal, useStudio } from "./StudioContext";
import { Chip } from "./ui";

type Tab = "Motion" | "Brand" | "Joints" | "Audio" | "Developer";
const TABS: Tab[] = ["Motion", "Brand", "Joints", "Audio", "Developer"];

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [core] = useState(() => new StudioCore());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useLocal<Lang>("studio.lang", "en");
  const [tab, setTab] = useLocal<Tab>("studio.tab", "Motion");
  const t = useMemo(() => makeT(lang), [lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  useEffect(() => {
    let dead = false;
    core.init(host.current!).then(() => !dead && setReady(true)).catch((e: Error) => !dead && setError(e.message));
    return () => {
      dead = true;
      core.dispose();
    };
  }, [core]);

  return (
    <StudioCtx.Provider value={{ core, t, lang }}>
      <div className="app">
        <div className="stage">
          <div ref={host} className="viewport" data-testid="viewport" />
          {!ready && !error && <div className="overlay">{t("Loading robot...")}</div>}
          {error && <div className="overlay err" role="alert">{/WebGL/i.test(error) ? t("WebGL is not available") : error}<small>{error}</small></div>}
          {ready && <Toolbar lang={lang} setLang={setLang} />}
        </div>
        <aside className="side">
          <nav className="tabs" role="tablist">
            {TABS.map((x) => (
              <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => setTab(x)} data-testid={`tab-${x}`}>{t(x)}</button>
            ))}
          </nav>
          <div className="panel">
            {ready && tab === "Motion" && <MotionPanel />}
            {ready && tab === "Brand" && <BrandPanel />}
            {ready && tab === "Joints" && <JointsPanel />}
            {ready && tab === "Audio" && <AudioPanel />}
            {ready && tab === "Developer" && <DevPanel />}
          </div>
        </aside>
      </div>
    </StudioCtx.Provider>
  );
}

function Toolbar({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const { core, t } = useStudio();
  useCoreChange();
  const cams: CameraPreset[] = ["full", "upper", "face", "side", "back"];
  const shot = () => {
    const a = document.createElement("a");
    a.href = core.viewer.screenshot();
    a.download = `robot-${core.style}.png`;
    a.click();
  };
  return (
    <div className="toolbar">
      <h1>{t("Robot Avatar Studio")}</h1>
      <div className="tb-group">
        <label>{t("Style")}
          <select value={core.style} onChange={(e) => void core.loadStyle(e.target.value as Style)} data-testid="style-select">
            <option value="concierge">Concierge (realistic)</option>
            <option value="mascot">Mascot (chibi)</option>
            <option value="premium">Premium AI</option>
            <option value="friendly">Friendly</option>
            <option value="futuristic">Futuristic</option>
          </select>
        </label>
        <label>{t("Quality")}
          <select value={core.viewer.quality} onChange={(e) => core.setQuality(e.target.value as QualityLevel)} data-testid="quality-select">
            {(["low", "medium", "high"] as const).map((q) => <option key={q} value={q}>{t(q[0].toUpperCase() + q.slice(1))}</option>)}
          </select>
        </label>
        <label>{t("Background")}
          <select value={core.viewer.background} onChange={(e) => core.setBackground(e.target.value as BackgroundPreset)} data-testid="bg-select">
            {(["studio", "light", "dusk", "green", "transparent"] as const).map((b) => <option key={b}>{b}</option>)}
          </select>
        </label>
      </div>
      <div className="tb-group">
        {cams.map((c) => <Chip key={c} onClick={() => core.setCamera(c)} testId={`cam-${c}`}>{t(c[0].toUpperCase() + c.slice(1))}</Chip>)}
        <Chip onClick={() => core.robot.resetPose({ position: true })} testId="reset">{t("Reset pose")}</Chip>
        <Chip onClick={shot}>{t("Screenshot")}</Chip>
        <Chip onClick={() => setLang(lang === "en" ? "ar" : "en")} testId="lang">{lang === "en" ? "العربية" : "English"}</Chip>
      </div>
    </div>
  );
}
