import { createContext, useContext, useEffect, useReducer, useState } from "react";
import type { StudioCore } from "./core";
import type { T, Lang } from "./i18n";

export interface Ctx {
  core: StudioCore;
  t: T;
  lang: Lang;
}
export const StudioCtx = createContext<Ctx>(null as never);
export const useStudio = () => useContext(StudioCtx);

/** re-render at `hz` (default 6) so panels show live robot values without re-rendering at 60 FPS */
export function useTick(hz = 6) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(force, 1000 / hz);
    return () => clearInterval(id);
  }, [hz]);
}

/** re-render when the core announces a structural change (style, selection...) */
export function useCoreChange() {
  const { core } = useStudio();
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const off = core.subscribe(force);
    return () => {
      off();
    };
  }, [core]);
}

export function useLocal<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, set] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (n: T) => {
      set(n);
      try {
        localStorage.setItem(key, JSON.stringify(n));
      } catch {
        /* storage unavailable (private mode) */
      }
    },
  ];
}
