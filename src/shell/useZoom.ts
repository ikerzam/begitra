// The window's zoom from the settings (Settings › Appearance, Ctrl + and Ctrl −, the palette):
// the webview scales every size at once, so text, rows and gaps keep their proportions and the
// lists' fixed row heights still hold, which a larger type scale alone would break. Outside
// Tauri (the tests, a browser) nothing scales.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { watch } from "vue";

import { useShortcut } from "@/shortcuts/useShortcut";
import { useSettingsStore, zoomLevels, type ZoomLevel } from "@/stores/settings";

/** The level one step up or down from `zoom`, staying at the ends. */
export function stepZoom(zoom: ZoomLevel, direction: 1 | -1): ZoomLevel {
  const at = zoomLevels.indexOf(zoom);
  const next = Math.min(zoomLevels.length - 1, Math.max(0, (at < 0 ? 2 : at) + direction));
  return zoomLevels[next] ?? 100;
}

/** Scales the webview to `zoom` percent. */
export async function applyZoom(zoom: ZoomLevel): Promise<void> {
  try {
    await getCurrentWebview().setZoom(zoom / 100);
  } catch {
    // Not running inside Tauri.
  }
}

/** Keeps the webview's zoom on the setting and binds the zoom shortcuts to it. */
export function useZoom(): void {
  const settings = useSettingsStore();
  watch(
    () => settings.values.zoom,
    (zoom) => void applyZoom(zoom),
    { immediate: true },
  );
  useShortcut("zoom-in", () => void settings.update("zoom", stepZoom(settings.values.zoom, 1)));
  useShortcut("zoom-out", () => void settings.update("zoom", stepZoom(settings.values.zoom, -1)));
  useShortcut("zoom-reset", () => void settings.update("zoom", 100));
}
