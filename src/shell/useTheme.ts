// The theme on the document root: `data-theme` is the setting's theme, and for
// `system` `dark` or `light` from `prefers-color-scheme`, followed while the app runs. The
// tokens do the rest; components never read the theme (`GraphCanvas` repaints on the
// attribute, since a canvas holds no custom properties). The window's own chrome (the title
// bar) follows the theme's brightness through Tauri's `setTheme`, a no-op outside the app.
// The code theme is the same attribute on the diff's body of rows (`useCodeTheme`).

import { getCurrentWindow } from "@tauri-apps/api/window";
import { computed, onBeforeUnmount, onMounted, watch, type ComputedRef } from "vue";

import { useSettingsStore, type Theme, type ThemeName } from "@/stores/settings";
import { PALETTE_THEMES } from "@/styles/themes";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Whether a theme is dark or light. */
export function brightnessOf(theme: ThemeName): "dark" | "light" {
  if (theme === "dark" || theme === "light") return theme;
  return PALETTE_THEMES.find((palette) => palette.id === theme)?.brightness ?? "dark";
}

/** The theme the platform asks for; dark when the query is unavailable (jsdom, an old webview). */
export function platformTheme(): "dark" | "light" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

/** The theme a setting resolves to. */
export function resolveTheme(setting: Theme): ThemeName {
  return setting === "system" ? platformTheme() : setting;
}

/** Writes the resolved theme on the document root and asks the window's chrome to follow. */
export function applyTheme(setting: Theme): ThemeName {
  const theme = resolveTheme(setting);
  document.documentElement.dataset["theme"] = theme;
  void windowTheme(setting === "system" ? null : brightnessOf(theme));
  return theme;
}

/**
 * The `data-theme` of the diff's body of rows: the code theme, or nothing for the window's,
 * which the body then inherits from the document root.
 */
export function useCodeTheme(): ComputedRef<ThemeName | undefined> {
  const settings = useSettingsStore();
  return computed(() => {
    const theme = settings.values.codeTheme;
    return theme === "app" ? undefined : theme;
  });
}

/** The native window's theme: `null` follows the platform. Outside Tauri there is no window. */
async function windowTheme(theme: "dark" | "light" | null): Promise<void> {
  try {
    await getCurrentWindow().setTheme(theme);
  } catch {
    // Not running inside Tauri (the tests, a browser).
  }
}

/** Keeps the document root's theme in step with the setting and the platform. */
export function useTheme(): void {
  const settings = useSettingsStore();
  let query: MediaQueryList | null = null;
  const onChange = (): void => {
    if (settings.values.theme === "system") applyTheme("system");
  };

  onMounted(() => {
    applyTheme(settings.values.theme);
    if (typeof window.matchMedia === "function") {
      query = window.matchMedia(LIGHT_QUERY);
      query.addEventListener("change", onChange);
    }
  });

  watch(
    () => settings.values.theme,
    (theme) => applyTheme(theme),
  );

  onBeforeUnmount(() => {
    query?.removeEventListener("change", onChange);
  });
}
