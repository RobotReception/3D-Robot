import { useRef, useState, type ReactNode } from "react";

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="sec">
      <header>
        <h3>{title}</h3>
        {right}
      </header>
      <div className="sec-body">{children}</div>
    </section>
  );
}

export function Chip({ active, onClick, children, title, tone, testId }: { active?: boolean; onClick: () => void; children: ReactNode; title?: string; tone?: string; testId?: string }) {
  return (
    <button className={`chip${active ? " on" : ""}${tone ? " " + tone : ""}`} onClick={onClick} title={title} type="button" data-testid={testId}>
      {children}
    </button>
  );
}

export function Slider(props: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void; readout?: number | string; disabled?: boolean; testId?: string;
}) {
  const { label, value, min, max, step = 1, unit = "°", onChange, readout, disabled, testId } = props;
  // For a moment after the user edits (mouse, touch or keyboard) show the value they chose: the live robot
  // value lags behind by the smoothing time and would otherwise snap the thumb back mid-gesture.
  const [local, setLocal] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const edit = (v: number) => {
    setLocal(v);
    onChange(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLocal(null), 700);
  };
  const shown = local ?? value;
  return (
    <label className="slider">
      <span className="sl-label">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={Number.isFinite(shown) ? shown : 0} disabled={disabled}
        data-testid={testId}
        onChange={(e) => edit(parseFloat(e.target.value))}
      />
      <span className="sl-val">{readout ?? shown.toFixed(step < 1 ? 2 : 0)}{unit}</span>
    </label>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="row">{children}</div>;
}
