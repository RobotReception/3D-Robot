import { useRef } from "react";
import type { ColorPart } from "../../engine/RobotAvatar";
import { assetUrl } from "../core";
import { useCoreChange, useStudio } from "../StudioContext";
import { Chip, Row, Section, Slider } from "../ui";

const PARTS: { part: ColorPart; label: string }[] = [
  { part: "body", label: "Body" },
  { part: "trim", label: "Panels" },
  { part: "uniform", label: "Uniform" },
  { part: "joints", label: "Joints" },
  { part: "accent", label: "Trims" },
  { part: "visor", label: "Screen" },
  { part: "eyes", label: "Eyes" },
  { part: "light", label: "Lights" },
];

/** ready-made brand looks: colours (any part a model lacks is skipped) + optional chest logo */
export const BRAND_PRESETS: Record<string, { colors: Partial<Record<ColorPart, string>>; logo?: string }> = {
  "Al-Razi University": {
    colors: { body: "#f5f7fa", trim: "#acd9e7", uniform: "#0080c6", joints: "#1d3d5c", accent: "#f78a2c", visor: "#02060c", eyes: "#7fd3ff", light: "#0080c6" },
    logo: "logos/alrazi.png",
  },
  "Midnight": { colors: { body: "#eef1f5", trim: "#9aa6b8", uniform: "#0b1730", joints: "#1a1f29", accent: "#c9a46a", eyes: "#6fd6ff", light: "#3aa8ff" } },
  "Graphite": { colors: { body: "#2b2f36", trim: "#454c57", uniform: "#16191e", joints: "#0f1114", accent: "#b8bec8", eyes: "#9ff0ff", light: "#62e0ff" } },
  "Emerald": { colors: { body: "#f4f6f5", trim: "#b9d8cc", uniform: "#0e5a43", joints: "#17251f", accent: "#d4af37", eyes: "#7dffcf", light: "#2fd39a" } },
};

export function BrandPanel() {
  const { core, t } = useStudio();
  useCoreChange();
  const file = useRef<HTMLInputElement>(null);
  const colors = core.robot.getColors();
  const b = core.brand;
  return (
    <>
      <Section title={t("Brand presets")}>
        <Row>
          {Object.entries(BRAND_PRESETS).map(([name, p]) => (
            <Chip key={name} active={b.preset === name} onClick={() => void core.applyBrand({ preset: name, colors: p.colors, logo: p.logo ? assetUrl(p.logo) : null })} testId={`brand-${name}`}>{t(name)}</Chip>
          ))}
          <Chip onClick={() => void core.applyBrand({ preset: null, colors: {}, logo: null })} testId="brand-reset">{t("Original")}</Chip>
        </Row>
      </Section>
      <Section title={t("Colors")}>
        <div className="colors">
          {PARTS.filter((p) => colors[p.part]).map(({ part, label }) => (
            <label key={part} className="color">
              <input type="color" value={colors[part]} data-testid={`color-${part}`}
                onChange={(e) => void core.applyBrand({ preset: null, colors: { ...b.colors, [part]: e.target.value }, logo: b.logo })} />
              <span>{t(label)}</span>
            </label>
          ))}
        </div>
      </Section>
      <Section title={t("Chest logo")}>
        <Row>
          <input ref={file} type="file" accept="image/*" data-testid="logo-file" onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void core.applyBrand({ ...b, logo: URL.createObjectURL(f) });
          }} />
        </Row>
        {b.logo && <img className="logo-prev" src={b.logo} alt="" />}
        <Slider label={t("Size")} value={b.logoSize * 100} min={4} max={16} step={0.5} unit=" cm" onChange={(v) => void core.applyBrand({ ...b, logoSize: v / 100 })} />
        <Row>
          <Chip active={b.placement === "center"} onClick={() => void core.applyBrand({ ...b, placement: "center" })}>{t("Center")}</Chip>
          <Chip active={b.placement === "left"} onClick={() => void core.applyBrand({ ...b, placement: "left" })}>{t("Left chest")}</Chip>
          <Chip active={b.placement === "auto"} onClick={() => void core.applyBrand({ ...b, placement: "auto" })}>{t("Auto")}</Chip>
          {b.logo && <Chip tone="danger" onClick={() => { if (file.current) file.current.value = ""; void core.applyBrand({ ...b, logo: null }); }} testId="logo-remove">{t("Remove logo")}</Chip>}
        </Row>
        <p className="hint">{t("PNG with a transparent background looks best.")}</p>
      </Section>
    </>
  );
}
