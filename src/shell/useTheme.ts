// The theme on the document root: `data-theme` is `dark` or `light` from
// the setting, and for `system` from `prefers-color-scheme`, followed while the app runs.
// The tokens do the rest; components never read the theme (`GraphCanvas` repaints on the
// attribute, since a canvas holds no custom properties). The window's own chrome (the title
// bar) follows through Tauri's `setTheme`, which is a no-op outside the app.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { onBeforeUnmount, onMounted, watch } from "vue";

import { useSettingsStore, type Theme } from "@/stores/settings";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** The theme the platform asks for; dark when the query is unavailable (jsdom, an old webview). */
export function platformTheme(): Exclude<Theme, "system"> {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

/** The theme a setting resolves to. */
export function resolveTheme(setting: Theme): Exclude<Theme, "system"> {
  return setting === "system" ? platformTheme() : setting;
}

/** Writes the resolved theme on the document root and asks the window's chrome to follow. */
export function applyTheme(setting: Theme): Exclude<Theme, "system"> {
  const theme = resolveTheme(setting);
  document.documentElement.dataset["theme"] = theme;
  void windowTheme(setting === "system" ? null : theme);
  return theme;
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
