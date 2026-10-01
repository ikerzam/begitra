// User settings, persisted through tauri-plugin-store in `settings.json`. The store starts
// with platform defaults, `init` overlays what the file holds (each key validated on its own,
// so a bad value falls back to its default), and every `update` writes through. The keys of
// the versions before projects (the scan folders, the last repository, the folder view and the
// project tab) are read once into `legacy` for the projects' migration step, which then drops
// them (`dropLegacy`).

import { load } from "@tauri-apps/plugin-store";
import { defineStore } from "pinia";
import * as v from "valibot";
import { computed, ref } from "vue";

import { defaultSkipFolders } from "@/ipc/commands";
import { detectPlatform, type Platform } from "@/shortcuts/platform";
import { PALETTE_THEMES, type PaletteThemeId } from "@/styles/themes";

import { lineTemplates } from "./externalTemplates";

export type LayoutMode =
  "graph" | "review" | "compare" | "worktrees" | "settings" | "changes" | "overview";
export type TabWidth = 2 | 4 | 8;

/** The filters a new review starts with (the settings' Diff section, "Hide by default"). */
export interface HideByDefault {
  generated: boolean;
  lockfiles: boolean;
  tests: boolean;
}
export type Locale = "en" | "es";
/** A theme: Begitra's own dark and light, or one of design/themes.json's palettes. */
export type ThemeName = "dark" | "light" | PaletteThemeId;
/** The theme of the window: `system` follows `prefers-color-scheme` between dark and light. */
export type Theme = "system" | ThemeName;
/** The theme of the diff's code: `app` is the window's. */
export type CodeTheme = "app" | ThemeName;
/** Every theme, Begitra's own first, then the palettes by name. */
export const themeNames: readonly ThemeName[] = [
  "dark",
  "light",
  ...PALETTE_THEMES.map((theme) => theme.id),
];
/** A font weight as a step from the design's: -1, 0, +1 and +2 hundreds. */
export type FontWeight = "light" | "regular" | "medium" | "semibold";
/** The order of the Branches tab: by the last commit, or by name. */
export type BranchSort = "recent" | "name";
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

/** Widths in px of the resizable columns of the table with a header; the last takes the rest. */
export interface ColumnWidths {
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
  /** "Editor at a line": a template with `{path}` and `{line}`; empty derives it from the
   * editor command for the editors Begitra knows (`externalTemplates.ts`). */
  editorLineCommand: string;
  paneSizes: PaneSizes;
  columnWidths: ColumnWidths;
  sidebarCollapsed: boolean;
  layoutMode: LayoutMode;
  locale: Locale;
  /** Ids of the last commands run from the palette, most recent first. */
  paletteRecents: string[];
  /** Folder names the scanner never enters. */
  skipFolders: string[];
  /** How deep under a folder project's folder the scanner goes (0 is the folder itself). */
  maxDepth: number;
  /** The open project, reopened at launch; null shows Home. */
  activeProject: number | null;
  /** Unix seconds of the last finished or stopped scan; null when none ran. */
  lastScanAt: number | null;
  /** The diff viewer's layout. */
  diffLayout: DiffLayout;
  /** Wrap long lines in the diff viewer. */
  diffWrap: boolean;
  /** Compute diffs ignoring whitespace changes. */
  diffIgnoreWhitespace: boolean;
  /** Show every unchanged line of a file in the diff viewer, not only the hunks' context. */
  diffWholeFile: boolean;
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
  /** The theme of the diff's code, or the window's. */
  codeTheme: CodeTheme;
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
  /** The order of the Branches tab. */
  branchSort: BranchSort;
  /** An icon of each file's kind in the file lists. */
  fileIcons: boolean;
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
  editorLineCommand: v.pipe(v.string(), v.maxLength(400)),
  paneSizes: v.object({ sidebar: px, detail: v.nullable(px), files: px, reviewRail: px }),
  columnWidths: v.object({
    worktrees: v.object({ path: px, branch: px, state: px, ahead: px }),
  }),
  sidebarCollapsed: v.boolean(),
  layoutMode: v.picklist([
    "graph",
    "review",
    "compare",
    "worktrees",
    "settings",
    "changes",
    "overview",
  ]),
  locale: v.picklist(["en", "es"]),
  paletteRecents: v.array(v.string()),
  skipFolders: v.array(path),
  maxDepth: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(32)),
  activeProject: v.nullable(v.pipe(v.number(), v.integer())),
  lastScanAt: v.nullable(v.pipe(v.number(), v.minValue(0))),
  diffLayout: v.picklist(["unified", "side-by-side"]),
  diffWrap: v.boolean(),
  diffIgnoreWhitespace: v.boolean(),
  diffWholeFile: v.boolean(),
  compare: v.nullable(v.object({ a: endpoint, b: endpoint })),
  worktreeFolder: v.nullable(path),
  gitExecutable: v.nullable(path),
  tabWidth: v.picklist([2, 4, 8]),
  hideByDefault: v.object({ generated: v.boolean(), lockfiles: v.boolean(), tests: v.boolean() }),
  shortcuts: v.record(v.string(), v.pipe(v.string(), v.minLength(1), v.maxLength(40))),
  theme: v.picklist<Theme[]>(["system", ...themeNames]),
  codeTheme: v.picklist<CodeTheme[]>(["app", ...themeNames]),
  uiFont: v.pipe(v.string(), v.maxLength(64)),
  uiWeight: v.picklist(fontWeights),
  codeFont: v.pipe(v.string(), v.maxLength(64)),
  codeWeight: v.picklist(fontWeights),
  zoom: v.picklist(zoomLevels),
  branchSort: v.picklist(["recent", "name"]),
  fileIcons: v.boolean(),
};

export const settingsKeys = Object.keys(schemas) as (keyof Settings)[];

/**
 * What a settings file of a version before projects held, for the one-time step that turns it
 * into projects: the scan folders, the repository to reopen, the folder the folder view showed,
 * and whether the app was left on the project view or the folder view.
 */
export interface LegacySettings {
  scanRoots: string[];
  lastRepository: string | null;
  folderView: string | null;
  /** The layout of the project view (`project`) or the folder view (`folder`); null otherwise. */
  layoutMode: "project" | "folder" | null;
}

/** The keys `LegacySettings` reads, dropped from the file once the step ran. */
export const legacyKeys = ["scanRoots", "lastRepository", "folderView", "projectTab"] as const;

const legacySchemas = {
  scanRoots: v.array(path),
  lastRepository: v.nullable(path),
  folderView: v.nullable(path),
};

/** The layout the project view and the folder view map to: the Overview and the Changes. */
const legacyLayouts: Record<string, LayoutMode> = { project: "overview", folder: "changes" };

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

/** The worktrees table's default column widths. */
export function defaultColumnWidths(): ColumnWidths {
  return {
    worktrees: { path: 200, branch: 200, state: 96, ahead: 84 },
  };
}

export function defaultSettings(platform: Platform): Settings {
  const defaults = platformDefaults(platform);
  return {
    terminalCommand: defaults.terminal[0] ?? "",
    editorCommand: defaults.editor[0] ?? "",
    editorLineCommand: "",
    paneSizes: { sidebar: 240, detail: null, files: 280, reviewRail: 280 },
    columnWidths: defaultColumnWidths(),
    sidebarCollapsed: false,
    layoutMode: "graph",
    locale: "en",
    paletteRecents: [],
    skipFolders: [...defaultSkipFolders],
    maxDepth: 2,
    activeProject: null,
    lastScanAt: null,
    diffLayout: "unified",
    diffWrap: false,
    diffIgnoreWhitespace: false,
    diffWholeFile: false,
    compare: null,
    worktreeFolder: null,
    gitExecutable: null,
    tabWidth: 4,
    hideByDefault: { generated: true, lockfiles: true, tests: false },
    shortcuts: {},
    theme: "system",
    codeTheme: "app",
    uiFont: "",
    uiWeight: "regular",
    codeFont: "",
    codeWeight: "regular",
    zoom: 100,
    branchSort: "recent",
    fileIcons: true,
  };
}

/** The subset of the plugin store the settings need, so tests can use memory. */
export interface SettingsStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
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
    delete: (key) => Promise.resolve(data.delete(key)),
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
  /** What the file held of a version before projects; null when it held none of it. */
  const legacy = ref<LegacySettings | null>(null);
  let storage: SettingsStorage | undefined;
  /** Values changed since the last write, by key; kept until `init` when it has not run. */
  const pending = new Map<keyof Settings, unknown>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let settle: (() => void) | undefined;

  /** Reads every key from `backend`; invalid or missing keys keep their default. Values
   * updated before the read finished win over the stored ones and are written through. The
   * keys of a version before projects land in `legacy`, and its project and folder views map
   * to the Overview and the Changes. */
  async function init(backend: SettingsStorage, forPlatform = platform.value): Promise<void> {
    platform.value = forPlatform;
    const next = defaultSettings(forPlatform);
    const stored = await Promise.all(settingsKeys.map((key) => backend.get<unknown>(key)));
    const layout = stored[settingsKeys.indexOf("layoutMode")];
    const oldLayout = typeof layout === "string" ? legacyLayouts[layout] : undefined;
    settingsKeys.forEach((key, index) => {
      const parsed = v.safeParse(schemas[key], stored[index]);
      if (parsed.success) (next as unknown as Record<string, unknown>)[key] = parsed.output;
    });
    // The mapped layout is written through, so the file holds no retired layout past this read.
    if (oldLayout && !pending.has("layoutMode")) pending.set("layoutMode", oldLayout);
    legacy.value = await readLegacy(backend, oldLayout ? (layout as "project" | "folder") : null);
    for (const [key, value] of pending) (next as unknown as Record<string, unknown>)[key] = value;
    values.value = next;
    storage = backend;
    loaded.value = true;
    if (pending.size > 0) await flush();
  }

  /** The keys of a version before projects, validated one by one; null when none is there. */
  async function readLegacy(
    backend: SettingsStorage,
    layoutMode: "project" | "folder" | null,
  ): Promise<LegacySettings | null> {
    const [roots, last, folder, tab] = await Promise.all(
      legacyKeys.map((key) => backend.get<unknown>(key)),
    );
    if ([roots, last, folder, tab].every((value) => value === undefined) && layoutMode === null) {
      return null;
    }
    const parse = <T>(schema: v.GenericSchema<unknown, T>, value: unknown, fallback: T): T => {
      const parsed = v.safeParse(schema, value);
      return parsed.success ? parsed.output : fallback;
    };
    return {
      scanRoots: parse(legacySchemas.scanRoots, roots, []),
      lastRepository: parse(legacySchemas.lastRepository, last, null),
      folderView: parse(legacySchemas.folderView, folder, null),
      layoutMode,
    };
  }

  /** Drops the keys of a version before projects from the file, once their step ran. */
  async function dropLegacy(): Promise<void> {
    legacy.value = null;
    if (!storage) return;
    const backend = storage;
    for (const key of legacyKeys) await backend.delete(key);
    await backend.save();
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

  /** The templates for a file at a line: "Editor at a line", then each editor template's
   * at-line form when known, then the template itself. */
  const editorLineTemplates = computed(() =>
    lineTemplates(values.value.editorLineCommand, editorTemplates.value),
  );

  return {
    platform,
    values,
    loaded,
    legacy,
    init,
    update,
    flush,
    dropLegacy,
    terminalTemplates,
    editorTemplates,
    editorLineTemplates,
  };
});
