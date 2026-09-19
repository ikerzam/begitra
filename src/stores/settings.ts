// User settings, persisted through tauri-plugin-store in `settings.json`. The store starts
// with platform defaults, `init` overlays what the file holds (each key validated on its own,
// so a bad value falls back to its default), and every `update` writes through.

import { load } from "@tauri-apps/plugin-store";
import { defineStore } from "pinia";
import * as v from "valibot";
import { computed, ref } from "vue";

import { detectPlatform, type Platform } from "@/shortcuts/platform";

export type LayoutMode = "graph" | "review";
export type Locale = "en" | "es";

export interface PaneSizes {
  sidebar: number;
  /** Pinned width after a drag; null keeps the default fraction of the window. */
  detail: number | null;
  files: number;
  reviewRail: number;
}

export interface Settings {
  terminalCommand: string;
  editorCommand: string;
  paneSizes: PaneSizes;
  sidebarCollapsed: boolean;
  layoutMode: LayoutMode;
  locale: Locale;
  /** Ids of the last commands run from the palette, most recent first. */
  paletteRecents: string[];
}

const px = v.pipe(v.number(), v.minValue(0), v.maxValue(10_000));

const schemas: { [K in keyof Settings]: v.GenericSchema<unknown, Settings[K]> } = {
  terminalCommand: v.pipe(v.string(), v.minLength(1)),
  editorCommand: v.pipe(v.string(), v.minLength(1)),
  paneSizes: v.object({ sidebar: px, detail: v.nullable(px), files: px, reviewRail: px }),
  sidebarCollapsed: v.boolean(),
  layoutMode: v.picklist(["graph", "review"]),
  locale: v.picklist(["en", "es"]),
  paletteRecents: v.array(v.string()),
};

export const settingsKeys = Object.keys(schemas) as (keyof Settings)[];

/** Command templates per platform; the first entry is the default, the rest are fallbacks. */
export function platformDefaults(platform: Platform): { terminal: string[]; editor: string[] } {
  switch (platform) {
    case "windows":
      return { terminal: ["wt -d {path}", "cmd /K cd /d {path}"], editor: ["code {path}"] };
    case "macos":
      return { terminal: ["open -a Terminal {path}"], editor: ["code {path}"] };
    default:
      return {
        terminal: ["x-terminal-emulator --working-directory={path}"],
        editor: ["code {path}"],
      };
  }
}

export function defaultSettings(platform: Platform): Settings {
  const defaults = platformDefaults(platform);
  return {
    terminalCommand: defaults.terminal[0] ?? "",
    editorCommand: defaults.editor[0] ?? "",
    paneSizes: { sidebar: 240, detail: null, files: 280, reviewRail: 280 },
    sidebarCollapsed: false,
    layoutMode: "graph",
    locale: "en",
    paletteRecents: [],
  };
}

/** The subset of the plugin store the settings need, so tests can use memory. */
export interface SettingsStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

/** The on-disk store of the app (`settings.json` in the app data folder). */
export function tauriStorage(): Promise<SettingsStorage> {
  return load("settings.json", { autoSave: 200 });
}

/** An in-memory storage for tests and for running without Tauri. */
export function memoryStorage(initial: Partial<Record<string, unknown>> = {}): SettingsStorage & {
  saved: number;
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    saved: 0,
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    set(key, value) {
      data.set(key, value);
      return Promise.resolve();
    },
    save() {
      this.saved += 1;
      return Promise.resolve();
    },
  };
}

export const useSettingsStore = defineStore("settings", () => {
  const platform = ref<Platform>(detectPlatform());
  const values = ref<Settings>(defaultSettings(platform.value));
  const loaded = ref(false);
  let storage: SettingsStorage | undefined;

  /** Reads every key from `backend`; invalid or missing keys keep their default. */
  async function init(backend: SettingsStorage, forPlatform = platform.value): Promise<void> {
    platform.value = forPlatform;
    const next = defaultSettings(forPlatform);
    for (const key of settingsKeys) {
      const stored = await backend.get<unknown>(key);
      const parsed = v.safeParse(schemas[key], stored);
      if (parsed.success) (next as unknown as Record<string, unknown>)[key] = parsed.output;
    }
    values.value = next;
    storage = backend;
    loaded.value = true;
  }

  /** Changes one setting and writes it through. */
  async function update<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    values.value = { ...values.value, [key]: value };
    if (storage) {
      await storage.set(key, value);
      await storage.save();
    }
  }

  /** The configured terminal template first, then the platform fallbacks. */
  const terminalTemplates = computed(() => [
    values.value.terminalCommand,
    ...platformDefaults(platform.value).terminal.filter((t) => t !== values.value.terminalCommand),
  ]);

  const editorTemplates = computed(() => [
    values.value.editorCommand,
    ...platformDefaults(platform.value).editor.filter((t) => t !== values.value.editorCommand),
  ]);

  return { platform, values, loaded, init, update, terminalTemplates, editorTemplates };
});
