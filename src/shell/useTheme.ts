// The theme on the document root: `data-theme` is the setting's theme, and for
// `system` `dark` or `light` from `prefers-color-scheme`, followed while the app runs. The
// tokens do the rest; components never read the theme (`GraphCanvas` repaints on the
// attribute, since a canvas holds no custom properties). The window's own chrome (the title
// bar) follows the theme's brightness through Tauri's `setTheme`, a no-op outside the app.
// The code theme is the same attribute on the diff's body of rows (`useCodeTheme`). Each theme
// applied hands its background to the window, which keeps it for the next start: the window
// paints it from its first frame, before the page and the settings are read.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { computed, onBeforeUnmount, onMounted, watch, type ComputedRef } from "vue";

import * as ipc from "@/ipc/commands";
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

/**
 * Writes the resolved theme on the document root, asks the window's chrome to follow, and hands
 * the theme's background to the window.
 */
export function applyTheme(setting: Theme): ThemeName {
  const theme = resolveTheme(setting);
  document.documentElement.dataset["theme"] = theme;
  void windowTheme(setting === "system" ? null : brightnessOf(theme));
  void windowBackground();
  return theme;
}

/**
 * A computed colour (its red, green and blue channels, as the browser writes it) in six
 * hexadecimal digits after `#`; none for a translucent colour or anything else.
 */
export function hexOf(color: string): string | null {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(color.trim());
  if (!match || (match[4] !== undefined && Number(match[4]) < 1)) return null;
  const channels = [match[1], match[2], match[3]].map((part) => Number(part));
  if (channels.some((channel) => channel > 255)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The background the page paints now (`var(--bg-app)` on the body), for the window and its next
 * start: read as computed, since the built stylesheet writes a token as short as it can (black in
 * three digits).
 */
async function windowBackground(): Promise<void> {
  const background = hexOf(getComputedStyle(document.body).backgroundColor);
  if (background === null) return;
  try {
    await ipc.setWindowBackground(background);
  } catch {
    // Outside the app (the tests, a browser), or a window that keeps its colour: the next start
    // uses the one kept before.
  }
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

/**
 * Keeps the document root's theme in step with the setting and the platform, from the moment the
 * settings are read: until then the window keeps the background it started with, the theme
 * applied last, which the default theme would replace for a moment.
 */
export function useTheme(): void {
  const settings = useSettingsStore();
  let query: MediaQueryList | null = null;
  const onChange = (): void => {
    if (settings.loaded && settings.values.theme === "system") applyTheme("system");
  };

  onMounted(() => {
    if (typeof window.matchMedia === "function") {
      query = window.matchMedia(LIGHT_QUERY);
      query.addEventListener("change", onChange);
    }
  });

  watch(
    () => [settings.loaded, settings.values.theme] as const,
    ([loaded, theme]) => {
      if (loaded) applyTheme(theme);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    query?.removeEventListener("change", onChange);
  });
}
