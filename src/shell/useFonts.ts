// The fonts of the settings on the document root: a chosen family goes in front of the
// design's stack through `--font-ui-custom` and `--font-mono-custom` (the font tokens read
// them), the interface weight moves Tailwind's three weights by one step, and the code weight
// is `--code-weight`, which `text-code` takes. An empty family and the regular weight remove
// the properties, so the design's values apply.

import { watch } from "vue";

import { useSettingsStore, type FontWeight, type Settings } from "@/stores/settings";

const STEPS: Record<FontWeight, number> = { light: -1, regular: 0, medium: 1, semibold: 2 };

/** Generic families work only unquoted. */
const GENERIC = new Set([
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "ui-monospace",
  "ui-sans-serif",
  "ui-serif",
]);

/** Characters that could end the family or the property: quotes, escapes, `;`, braces. */
const UNSAFE = new Set(['"', "'", "\\", ";", "{", "}"]);

/** One family cleaned of what could escape the value and of control characters, 64 at most. */
function cleanFamily(name: string): string {
  const kept = [...name]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127 && !UNSAFE.has(char);
    })
    .join("");
  return kept.replace(/\s+/g, " ").trim().slice(0, 64).trim();
}

/**
 * Typed families (one, or a comma-separated list as editors take) as the first items of a
 * font-family list, with the trailing comma the tokens expect: each cleaned and quoted unless
 * it is a generic family; "" when no family is left.
 */
export function familyValue(name: string): string {
  const families = name
    .split(",")
    .map(cleanFamily)
    .filter((family) => family !== "");
  if (families.length === 0) return "";
  const quoted = families.map((family) => {
    const generic = family.toLowerCase();
    return GENERIC.has(generic) ? generic : `"${family}"`;
  });
  return `${quoted.join(", ")},`;
}

type FontSettings = Pick<Settings, "uiFont" | "uiWeight" | "codeFont" | "codeWeight">;

/** The properties the settings put on the document root; null removes one. */
export function fontProperties(settings: FontSettings): Record<string, string | null> {
  const ui = STEPS[settings.uiWeight] * 100;
  const code = STEPS[settings.codeWeight] * 100;
  return {
    "--font-ui-custom": familyValue(settings.uiFont) || null,
    "--font-mono-custom": familyValue(settings.codeFont) || null,
    "--font-weight-normal": ui === 0 ? null : String(400 + ui),
    "--font-weight-medium": ui === 0 ? null : String(500 + ui),
    "--font-weight-semibold": ui === 0 ? null : String(600 + ui),
    "--code-weight": code === 0 ? null : String(400 + code),
  };
}

/** Writes the fonts of `settings` on the document root. */
export function applyFonts(settings: FontSettings): void {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(fontProperties(settings))) {
    if (value === null) style.removeProperty(name);
    else style.setProperty(name, value);
  }
}

/** Keeps the document root's fonts in step with the settings. */
export function useFonts(): void {
  const settings = useSettingsStore();
  // The four values, not the settings object: every write replaces it.
  watch(
    [
      () => settings.values.uiFont,
      () => settings.values.uiWeight,
      () => settings.values.codeFont,
      () => settings.values.codeWeight,
    ],
    ([uiFont, uiWeight, codeFont, codeWeight]) =>
      applyFonts({ uiFont, uiWeight, codeFont, codeWeight }),
    { immediate: true },
  );
}
