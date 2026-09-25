// The fonts the Appearance fields suggest: the platform's own, then ones a developer often
// installs anywhere. Suggestions only: any installed font can be typed. Names are the ones a
// webview resolves ("Segoe UI Variable" alone falls back; its "Text" face does not).

import type { Platform } from "@/shortcuts/platform";

const UI: Record<Platform, readonly string[]> = {
  windows: ["Segoe UI", "Segoe UI Variable Text"],
  macos: ["Helvetica Neue", "Avenir Next"],
  linux: ["Ubuntu", "Cantarell", "Noto Sans", "DejaVu Sans"],
};
const CODE: Record<Platform, readonly string[]> = {
  windows: ["Cascadia Code", "Cascadia Mono", "Consolas"],
  macos: ["Menlo", "Monaco", "ui-monospace"],
  linux: ["DejaVu Sans Mono", "Ubuntu Mono", "Noto Sans Mono"],
};
const UI_ANYWHERE = ["Inter", "Roboto", "system-ui"];
const CODE_ANYWHERE = ["JetBrains Mono", "Fira Code", "Source Code Pro"];

/** The suggestions of the interface and code font fields on `platform`. */
export function fontSuggestions(platform: Platform): { ui: string[]; code: string[] } {
  return { ui: [...UI[platform], ...UI_ANYWHERE], code: [...CODE[platform], ...CODE_ANYWHERE] };
}
