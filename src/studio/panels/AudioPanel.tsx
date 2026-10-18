import { useEffect, useRef, useState } from "react";
import { AudioController, speechSynthesisAvailable, type LoadedAudio } from "../../engine/AudioController";
import { estimateSpeechDuration } from "../../engine/lipsync/phonemizer";
import { VISEMES } from "../../engine/lipsync/visemes";
import { assetUrl } from "../core";
import { useStudio, useTick } from "../StudioContext";
import { Chip, Row, Section, Slider } from "../ui";

type Mode = "hybrid" | "audio" | "text";
const SAMPLES = {
  en: "Hello! I'm your robot assistant. How can I help you today?",
  ar: "مرحبًا! أنا مساعدك الروبوت. كيف أستطيع مساعدتك اليوم؟",
};

const COLORS: Record<string, string> = {
  PP: "#ff7a90", FF: "#ffb86b", TH: "#ffe27a", DD: "#b9f27a", kk: "#7af2c0", CH: "#6fd8ff", SS: "#7aa8ff", nn: "#b394ff", RR: "#e58bff",
  aa: "#ff5f6d", E: "#ffa14a", I: "#ffd84a", O: "#4adf8f", U: "#4ab6ff", sil: "#3a4153",
};

export function AudioPanel() {
  const { core, t } = useStudio();
  useTick(10);
  const r = core.robot;
  const [text, setText] = useState(SAMPLES.en);
  const [lang, setLang] = useState<"auto" | "en-US" | "ar-SA">("auto");
  const [mode, setMode] = useState<Mode>("hybrid");
  const [silent, setSilent] = useState(!speechSynthesisAvailable());
  const [rate, setRate] = useState(1);
  const [transcript, setTranscript] = useState("");
  const [loaded, setLoaded] = useState<{ name: string; audio: LoadedAudio } | null>(null);
  const [busy, setBusy] = useState("");
  const [offset, setOffset] = useState(r.lipsync.offsetMs);
  const [gain, setGain] = useState(r.lipsync.gain);
  const [hybrid, setHybrid] = useState(r.lipsync.hybrid);
  const canvas = useRef<HTMLCanvasElement>(null);
  const voices = speechSynthesisAvailable() ? window.speechSynthesis.getVoices().length : 0;

  useEffect(() => {
    r.lipsync.offsetMs = offset;
    r.lipsync.gain = gain;
    r.lipsync.hybrid = mode === "hybrid" ? hybrid : mode === "text" ? 0 : r.lipsync.hybrid;
  }, [r, offset, gain, hybrid, mode]);

  const langCode = lang === "auto" ? (/[؀-ۿ]/.test(text) ? "ar-SA" : "en-US") : lang;

  const speakText = () => {
    setBusy("");
    r.speak({ text, lang: langCode, tts: !silent, rate, emotion: "friendly" });
  };

  const playAudio = (audio: LoadedAudio, tr: string) => {
    const opts: Parameters<typeof r.speak>[0] = { audio, emotion: "friendly" };
    if (mode === "audio" || !tr.trim()) opts.visemes = audio.analysis.events;
    else if (mode === "text") opts.text = tr;
    else opts.text = tr; // hybrid: text events stretched to the audio + loudness gate
    r.speak(opts);
  };

  const loadSample = async (file: string, tr: string) => {
    setBusy("…");
    try {
      core.robot.audio ??= new AudioController();
      await core.robot.audio.resume();
      const audio = await core.robot.audio.load(assetUrl(`audio/${file}`));
      setLoaded({ name: file, audio });
      setTranscript(tr);
      playAudio(audio, tr);
    } finally {
      setBusy("");
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy("…");
    try {
      core.robot.audio ??= new AudioController();
      await core.robot.audio.resume();
      const audio = await core.robot.audio.loadFile(f);
      setLoaded({ name: f.name, audio });
    } finally {
      setBusy("");
    }
  };

  // timeline canvas
  const events = r.lipsync.events;
  const dur = Math.max(0.5, r.lipsync.timelineDuration);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    const W = c.width;
    const H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#12151c";
    g.fillRect(0, 0, W, H);
    for (const e of events) {
      if (e.viseme === "sil") continue;
      const x = (e.time / dur) * W;
      const w = Math.max(1.5, ((e.duration ?? 0.08) / dur) * W - 1);
      const h = Math.max(6, (e.weight ?? 1) * (H - 6));
      g.fillStyle = COLORS[e.viseme] ?? "#fff";
      g.fillRect(x, H - h, w, h);
    }
    if (loaded && events.length) {
      const env = loaded.audio.envelope;
      g.strokeStyle = "rgba(255,255,255,.35)";
      g.beginPath();
      for (let i = 0; i < env.data.length; i += 2) {
        const x = (i * env.hop / dur) * W;
        const y = H - env.data[i] * (H - 4);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    const px = (r.lipsync.currentTime / dur) * W;
    g.fillStyle = "#fff";
    g.fillRect(Math.min(W - 1, Math.max(0, px)), 0, 1.5, H);
  });

  const weights = r.lipsync.currentWeights;
  const est = estimateSpeechDuration(text, rate);

  return (
    <>
      <Section title={t("Text to speak")}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} dir="auto" data-testid="speak-text" />
        <Row>
          <Chip onClick={() => setText(SAMPLES.en)}>EN</Chip>
          <Chip onClick={() => setText(SAMPLES.ar)}>AR</Chip>
          <select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
            <option value="auto">{t("Auto")}</option>
            <option value="en-US">English</option>
            <option value="ar-SA">العربية</option>
          </select>
        </Row>
        <Row>
          <Chip onClick={speakText} testId="speak-btn" active={r.speaking}>{t("Speak")}</Chip>
          <Chip onClick={() => r.stopSpeech()} tone="danger">{t("Stop")}</Chip>
          <label className="inline"><input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} />{t("Silent preview")}</label>
        </Row>
        <Slider label={t("Rate")} min={0.6} max={1.6} step={0.05} unit="×" value={rate} onChange={setRate} />
        <p className="hint">≈ {est.toFixed(1)} s{voices === 0 && !silent ? ` · ${t("No voices installed: using silent preview")}` : ""}</p>
      </Section>

      <Section title={t("Upload audio")} right={<span className="tag">{busy || (loaded ? `${loaded.name} · ${loaded.audio.buffer.duration.toFixed(1)}s` : "—")}</span>}>
        <input type="file" accept="audio/*" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="audio-file" />
        <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={2} dir="auto" placeholder={t("Transcript (optional)")} />
        <Row>
          <Chip onClick={() => loaded && playAudio(loaded.audio, transcript)} testId="play-audio">▶ {t("Speak")}</Chip>
          <Chip onClick={() => r.stopSpeech()} tone="danger">{t("Stop")}</Chip>
        </Row>
        <h4>{t("Demo audio")}</h4>
        <Row>
          <Chip onClick={() => void loadSample("vowels.wav", "")} testId="demo-vowels">vowels.wav (a e i o u s)</Chip>
          <Chip onClick={() => void loadSample("hello.wav", "hello")} testId="demo-hello">hello.wav + "hello"</Chip>
        </Row>
      </Section>

      <Section title={t("Lip-sync mode")}>
        <Row>
          {(["hybrid", "audio", "text"] as const).map((m) => (
            <Chip key={m} active={mode === m} onClick={() => setMode(m)}>
              {t(m === "hybrid" ? "Hybrid (text + audio)" : m === "audio" ? "Audio analysis only" : "Text only")}
            </Chip>
          ))}
        </Row>
        <Slider label={t("Sync offset (ms)")} min={-250} max={250} step={5} unit="ms" value={offset} onChange={setOffset} testId="sync-offset" />
        <Slider label={t("Mouth gain")} min={0.3} max={1.5} step={0.05} unit="×" value={gain} onChange={setGain} />
        <Slider label={t("Hybrid gate")} min={0} max={1} step={0.05} unit="" value={hybrid} onChange={setHybrid} />
      </Section>

      <Section title={t("Timeline")}>
        <canvas ref={canvas} width={340} height={64} className="timeline" data-testid="timeline" />
        <div className="visemes">
          {VISEMES.filter((v) => v !== "sil").map((v) => {
            const w = weights[`viseme_${v}`] ?? 0;
            return (
              <div key={v} className="vm" title={v}>
                <div className="bar"><i style={{ height: `${Math.round(w * 100)}%`, background: COLORS[v] }} /></div>
                <span>{v}</span>
              </div>
            );
          })}
        </div>
        <p className="hint">{t("Visemes")}: {events.length} · {r.lipsync.timelineDuration.toFixed(2)} s</p>
      </Section>
    </>
  );
}
