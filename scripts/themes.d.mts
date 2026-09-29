// Types of scripts/themes.mjs for the TypeScript tests.

export interface Palette {
  id: string;
  name: string;
  brightness: "dark" | "light";
  source: string;
  bg: string;
  raised: string;
  border: string;
  borderStrong: string;
  text: string;
  secondary?: string;
  muted?: string;
  accent: string;
  red: string;
  orange: string;
  yellow: string;
  green: string;
  cyan: string;
  blue: string;
  purple: string;
  pink: string;
  gray: string;
  lanes?: string[];
  syntax: Record<"keyword" | "function" | "type" | "string" | "number" | "comment", string>;
}

export interface Lift {
  token: string;
  from: string;
  to: string;
}

export const FLOORS: Record<string, number>;
export const ON_FILL_FLOOR: number;
export function parseHex(hex: string): { r: number; g: number; b: number; a: number };
export function toHex(color: { r: number; g: number; b: number; a?: number }): string;
export function composite(hex: string, under: string): string;
export function luminance(hex: string): number;
export function contrast(hex: string, bg: string): number;
export function mix(a: string, b: string, t: number): string;
export function lift(hex: string, bg: string, floor: number): string;
export function mixToContrast(from: string, toward: string, bg: string, target: number): string;
export function withAlpha(hex: string, alpha: string): string;
export function deriveTokens(
  palette: Palette,
  names: string[],
): { tokens: Map<string, string>; lifts: Lift[]; onFill: number };
export function buildCss(
  darkTokens: Map<string, string>,
  themes: { palette: Palette; tokens: Map<string, string> }[],
): string;
export function buildTs(palettes: Palette[]): string;
