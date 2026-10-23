import type { ColorPart } from "../engine/RobotAvatar";
import type { LobbyBrand } from "../viewer/RobotViewer";

export interface BrandPreset {
  colors: Partial<Record<ColorPart, string>>;
  /** chest logo, relative to the app base (public/) */
  logo?: string;
  /** names, colours and logo for the lobby sign / desk plate */
  lobby?: Omit<LobbyBrand, "logo">;
}

/** ready-made brand looks: robot colours (a part a model lacks is skipped), chest logo and lobby branding */
export const BRAND_PRESETS: Record<string, BrandPreset> = {
  "Al-Razi University": {
    // from the official logo colour guide: 0080c6 blue, f78a2c orange, acd9e7 light blue
    colors: { body: "#f5f7fa", trim: "#acd9e7", uniform: "#006fb0", joints: "#1d3d5c", accent: "#f78a2c", visor: "#02060c", eyes: "#7fd3ff", light: "#0080c6" },
    logo: "logos/alrazi.png",
    lobby: { nameAr: "جامعة الرازي", nameEn: "Al-Razi University", primary: "#0080c6", accent: "#f78a2c" },
  },
  "Midnight": { colors: { body: "#eef1f5", trim: "#9aa6b8", uniform: "#0b1730", joints: "#1a1f29", accent: "#c9a46a", eyes: "#6fd6ff", light: "#3aa8ff" } },
  "Graphite": { colors: { body: "#2b2f36", trim: "#454c57", uniform: "#16191e", joints: "#0f1114", accent: "#b8bec8", eyes: "#9ff0ff", light: "#62e0ff" } },
  "Emerald": { colors: { body: "#f4f6f5", trim: "#b9d8cc", uniform: "#0e5a43", joints: "#17251f", accent: "#d4af37", eyes: "#7dffcf", light: "#2fd39a" } },
};

export const DEFAULT_BRAND = "Al-Razi University";
