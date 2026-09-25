// User settings, persisted through tauri-plugin-store in `settings.json`. The store starts
// with platform defaults, `init` overlays what the file holds (each key validated on its own,
// so a bad value falls back to its default), and every `update` writes through.

import { load } from "@tauri-apps/plugin-store";
import { defineStore } from "pinia";
import * as v from "valibot";
import { computed, ref } from "vue";

import { defaultSkipFolders } from "@/ipc/commands";
import { detectPlatform, type Platform } from "@/shortcuts/platform";

export type LayoutMode = "graph" | "review" | "compare" | "worktrees" | "settings" | "changes";
export type TabWidth = 2 | 4 | 8;

/** The filters a new review starts with (the settings' Diff section, "Hide by default"). */
export interface HideByDefault {
  generated: boolean;
  lockfiles: boolean;
  tests: boolean;
}
export type Locale = "en" | "es";
/** The theme: `system` follows `prefers-color-scheme`. */
export type Theme = "system" | "dark" | "light";
/** A font weight as a step from the design's: -1, 0, +1 and +2 hundreds. */
export type FontWeight = "light" | "regular" | "medium" | "semibold";
/** The zoom levels of the window, in percent. */
export const zoomLevels = [80, 90, 100, 110, 125, 150, 175, 200] as const;
export type ZoomLevel = (typeof zoomLevels)[number];

/** One side of a comparison: a revision, or a worktree meaning its checked-out commit. */
export interface CompareEndpoint {
  kind: "revision" | "worktree";
  /** What the engine is asked for: a ref name, a hash, or a worktree's branch or HEAD. */
  rev: string;
  /** What the screen shows: the branch, tag, short hash or worktree folder name. */
  label: string;
}

/** The two endpoints of the comparison the app was closed on. */
export interface CompareEndpoints {
  a: CompareEndpoint;
  b: CompareEndpoint;
}

/** Widths in px of the resizable columns of the two tables with a header; the last takes the rest. */
export interface ColumnWidths {
  home: { name: number; branch: number; ahead: number; commit: number };
  worktrees: { path: number; branch: number; state: number; ahead: number };
}

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
  columnWidths: ColumnWidths;
  sidebarCollapsed: boolean;
  layoutMode: LayoutMode;
  locale: Locale;
  /** Ids of the last commands run from the palette, most recent first. */
  paletteRecents: string[];
  /** Absolute paths the scanner walks for repositories. */
  scanRoots: string[];
  /** Folder names the scanner never enters. */
  skipFolders: string[];
  /** How deep under a scan folder the scanner goes (0 is the folder itself). */
  maxDepth: number;
  /** Root of the repository to reopen at launch; null starts on the home screen. */
  lastRepository: string | null;
  /** Unix seconds of the last finished or stopped scan; null when none ran. */
  lastScanAt: number | null;
  /** The diff viewer's layout. */
  diffLayout: DiffLayout;
  /** Wrap long lines in the diff viewer. */
  diffWrap: boolean;
  /** Compute diffs ignoring whitespace changes. */
  diffIgnoreWhitespace: boolean;
  /** The comparison to restore with the compare layout; null when none was open. */
  compare: CompareEndpoints | null;
  /** Where new worktrees go; null means a sibling folder of the repository. */
  worktreeFolder: string | null;
  /** The git executable the CLI runs; null means `git` on PATH. */
  gitExecutable: string | null;
  /** Tab stops of the diff viewer. */
  tabWidth: TabWidth;
  /** The file filters a new review starts with. */
  hideByDefault: HideByDefault;
  /** Shortcut overrides by binding id, in the registry's notation (`shift+mod+t`). */
  shortcuts: Record<string, string>;
  /** The theme of the window. */
  theme: Theme;
  /** An installed font for the interface, before Geist; empty for Geist. */
  uiFont: string;
  /** The interface's weight step. */
  uiWeight: FontWeight;
  /** An installed font for monospace text, before Geist Mono; empty for Geist Mono. */
  codeFont: string;
  /** The weight of the code in the viewers. */
  codeWeight: FontWeight;
  /** The window's zoom in percent: every size of the interface scales with it. */
  zoom: ZoomLevel;
}

export type DiffLayout = "unified" | "side-by-side";

/** The weight steps in the order the settings screen offers them. */
export const fontWeights: readonly FontWeight[] = ["light", "regular", "medium", "semibold"];

const px = v.pipe(v.number(), v.minValue(0), v.maxValue(10_000));
const path = v.pipe(v.string(), v.minLength(1));
const endpoint = v.object({
  kind: v.picklist(["revision", "worktree"]),
  rev: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1)),
});

const schemas: { [K in keyof Settings]: v.GenericSchema<unknown, Settings[K]> } = {
  terminalCommand: v.pipe(v.string(), v.minLength(1)),
  editorCommand: v.pipe(v.string(), v.minLength(1)),
  paneSizes: v.object({ sidebar: px, detail: v.nullable(px), files: px, reviewRail: px }),
  columnWidths: v.object({
    home: v.object({ name: px, branch: px, ahead: px, commit: px }),
    worktrees: v.object({ path: px, branch: px, state: px, ahead: px }),
  }),
  sidebarCollapsed: v.boolean(),
  layoutMode: v.picklist(["graph", "review", "compare", "worktrees", "settings", "changes"]),
  locale: v.picklist(["en", "es"]),
  paletteRecents: v.array(v.string()),
  scanRoots: v.array(path),
  skipFolders: v.array(path),
  maxDepth: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(32)),
  lastRepository: v.nullable(path),
  lastScanAt: v.nullable(v.pipe(v.number(), v.minValue(0))),
  diffLayout: v.picklist(["unified", "side-by-side"]),
  diffWrap: v.boolean(),
  diffIgnoreWhitespace: v.boolean(),
  compare: v.nullable(v.object({ a: endpoint, b: endpoint })),
  worktreeFolder: v.nullable(path),
  gitExecutable: v.nullable(path),
  tabWidth: v.picklist([2, 4, 8]),
  hideByDefault: v.object({ generated: v.boolean(), lockfiles: v.boolean(), tests: v.boolean() }),
  shortcuts: v.record(v.string(), v.pipe(v.string(), v.minLength(1), v.maxLength(40))),
  theme: v.picklist(["system", "dark", "light"]),
  uiFont: v.pipe(v.string(), v.maxLength(64)),
  uiWeight: v.picklist(fontWeights),
  codeFont: v.pipe(v.string(), v.maxLength(64)),
  codeWeight: v.picklist(fontWeights),
  zoom: v.picklist(zoomLevels),
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

/** The tables' default column widths. */
export function defaultColumnWidths(): ColumnWidths {
  return {
    home: { name: 200, branch: 180, ahead: 84, commit: 80 },
    worktrees: { path: 200, branch: 200, state: 96, ahead: 84 },
  };
}

export function defaultSettings(platform: Platform): Settings {
  const defaults = platformDefaults(platform);
  return {
    terminalCommand: defaults.terminal[0] ?? "",
    editorCommand: defaults.editor[0] ?? "",
    paneSizes: { sidebar: 240, detail: null, files: 280, reviewRail: 280 },
    columnWidths: defaultColumnWidths(),
    sidebarCollapsed: false,
    layoutMode: "graph",
    locale: "en",
    paletteRecents: [],
    scanRoots: [],
    skipFolders: [...defaultSkipFolders],
    maxDepth: 2,
    lastRepository: null,
    lastScanAt: null,
    diffLayout: "unified",
    diffWrap: false,
    diffIgnoreWhitespace: false,
    compare: null,
    worktreeFolder: null,
    gitExecutable: null,
    tabWidth: 4,
    hideByDefault: { generated: true, lockfiles: true, tests: false },
    shortcuts: {},
    theme: "system",
    uiFont: "",
    uiWeight: "regular",
    codeFont: "",
    codeWeight: "regular",
    zoom: 100,
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
