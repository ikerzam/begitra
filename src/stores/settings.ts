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
      // `cmd /K` starts in the working directory the spawner sets, so the path never goes
      // through cmd's own parsing (`&`, `^`, `%` in a folder name would break it). VS Code's
      // launcher on PATH is `code.cmd`, and a bare `code` only resolves to `code.exe`.
      return { terminal: ["wt -d {path}", "cmd /K"], editor: ["code.cmd {path}"] };
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

/** Quiet time after the last update before the pending values are written to disk. */
export const FLUSH_DELAY_MS = 200;

export const useSettingsStore = defineStore("settings", () => {
  const platform = ref<Platform>(detectPlatform());
  const values = ref<Settings>(defaultSettings(platform.value));
  const loaded = ref(false);
  let storage: SettingsStorage | undefined;
  /** Values changed since the last write, by key; kept until `init` when it has not run. */
  const pending = new Map<keyof Settings, unknown>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let settle: (() => void) | undefined;

  /** Reads every key from `backend`; invalid or missing keys keep their default. Values
   * updated before the read finished win over the stored ones and are written through. */
  async function init(backend: SettingsStorage, forPlatform = platform.value): Promise<void> {
    platform.value = forPlatform;
    const next = defaultSettings(forPlatform);
    const stored = await Promise.all(settingsKeys.map((key) => backend.get<unknown>(key)));
    settingsKeys.forEach((key, index) => {
      const parsed = v.safeParse(schemas[key], stored[index]);
      if (parsed.success) (next as unknown as Record<string, unknown>)[key] = parsed.output;
    });
    for (const [key, value] of pending) (next as unknown as Record<string, unknown>)[key] = value;
    values.value = next;
    storage = backend;
    loaded.value = true;
    if (pending.size > 0) await flush();
  }

  /** Writes every pending value and saves once; a no-op until `init` provided the storage. */
  async function flush(): Promise<void> {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!storage || pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    const backend = storage;
    for (const [key, value] of batch) await backend.set(key, value);
    await backend.save();
    settle?.();
    settle = undefined;
    flushing = undefined;
  }

  /**
   * Changes one setting now and writes it through after a short quiet time, so a drag that
   * updates a pane size on every mouse move ends in one write. Resolves once the value is
   * on disk (at once when there is no storage yet).
   */
  function update<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    values.value = { ...values.value, [key]: value };
    pending.set(key, value);
    if (!storage) return Promise.resolve();
    if (!flushing) {
      flushing = new Promise<void>((resolve) => {
        settle = resolve;
      });
    }
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
    return flushing;
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

  return { platform, values, loaded, init, update, flush, terminalTemplates, editorTemplates };
});
