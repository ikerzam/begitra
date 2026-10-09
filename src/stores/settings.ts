// User settings, persisted through tauri-plugin-store in `settings.json`. The store starts
// with platform defaults, `init` overlays what the file holds (each key validated on its own,
// so a bad value falls back to its default), and every `update` writes through. The keys of
// the versions before projects (the scan folders, the last repository, the folder view and the
// project tab) are read once into `legacy` for the projects' migration step, which then drops
// them (`dropLegacy`). The one layout of an earlier version's project tab (`layoutMode`) is read
// once into `launchLayout`, for the launch to show its tab.

import { load } from "@tauri-apps/plugin-store";
import { defineStore } from "pinia";
import * as v from "valibot";
import { computed, ref } from "vue";

import { defaultSkipFolders } from "@/ipc/commands";
import { detectPlatform, type Platform } from "@/shortcuts/platform";
import { PALETTE_THEMES, type PaletteThemeId } from "@/styles/themes";

import { lineTemplates } from "./externalTemplates";

/** The layouts a tab of their own shows: the fixed tabs' (⌘1 to ⌘4), the dashboard and the
 * settings. */
export type ProjectLayout = "graph" | "review" | "worktrees" | "settings" | "changes" | "overview";
/** The layout shown: a tab's, a comparison's included. */
export type LayoutMode = ProjectLayout | "compare";

/** The sections of the sidebar, each shown in its docked panel from the rail, in the rail's
 * order. */
export const sidebarSectionIds = ["repos", "local", "remote", "tags", "worktrees"] as const;
export type SidebarSectionId = (typeof sidebarSectionIds)[number];

/** The kinds of tab that show the sidebar, each with its panel open or closed. */
export const sidebarViews = ["graph", "review", "compare", "worktrees", "changes"] as const;
export type SidebarView = (typeof sidebarViews)[number];
export type SidebarPanels = Record<SidebarView, boolean>;
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
/** The order of the branch, remote branch and tag lists: by the last commit, or by name. */
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

/** The two endpoints of a comparison. */
export interface CompareEndpoints {
  a: CompareEndpoint;
  b: CompareEndpoint;
}

/** A tab opened on demand, as the settings keep it. */
export type StoredTab =
  ({ kind: "compare" } & CompareEndpoints) | { kind: "worktrees" } | { kind: "settings" };

/**
 * A project's tabs opened on demand, and the tab it showed: a fixed one by its kind, or an open
 * one by its place among them. `project` is the one tab of an earlier version's project, whose
 * layout the launch resolves (`launchLayout`).
 */
export interface ProjectTabs {
  open: StoredTab[];
  active: "graph" | "review" | "changes" | "overview" | "project" | number;
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
  /** Each project's tabs opened on demand and the tab it showed, by project id. */
  tabs: Record<string, ProjectTabs>;
  /** The section the sidebar's panel shows. */
  sidebarSection: SidebarSectionId;
  /** Whether the sidebar's panel is open, per kind of tab. */
  sidebarPanels: SidebarPanels;
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
  /** The order of the ref lists. */
  branchSort: BranchSort;
  /** An icon of each file's kind in the file lists. */
  fileIcons: boolean;
  /** The graph walks without the remote branches no local branch tracks. */
  graphHideRemotes: boolean;
  /** After a fetch or a pull, the main branch moves to its upstream when that is a
   * fast-forward of a branch no worktree has checked out. */
  moveMainAfterFetch: boolean;
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
const pair = v.object({ a: endpoint, b: endpoint });
const storedTab = v.variant("kind", [
  v.object({ kind: v.literal("compare"), a: endpoint, b: endpoint }),
  v.object({ kind: v.literal("worktrees") }),
  v.object({ kind: v.literal("settings") }),
]);
const projectTabs = v.object({
  open: v.array(storedTab),
  active: v.union([
    v.picklist(["graph", "review", "changes", "overview", "project"]),
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ]),
});
/** A project's tabs as the versions before every view was a tab kept them: its comparisons and
 * the tab shown, 0 the project's own, n the n-th comparison. */
const earlierProjectTabs = v.object({
  comparisons: v.array(pair),
  active: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const schemas: { [K in keyof Settings]: v.GenericSchema<unknown, Settings[K]> } = {
  terminalCommand: v.pipe(v.string(), v.minLength(1)),
  editorCommand: v.pipe(v.string(), v.minLength(1)),
  editorLineCommand: v.pipe(v.string(), v.maxLength(400)),
  paneSizes: v.object({ sidebar: px, detail: v.nullable(px), files: px, reviewRail: px }),
  columnWidths: v.object({
    worktrees: v.object({ path: px, branch: px, state: px, ahead: px }),
  }),
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
  tabs: v.record(v.string(), projectTabs),
  sidebarSection: v.picklist(sidebarSectionIds),
  sidebarPanels: v.object({
    graph: v.boolean(),
    review: v.boolean(),
    compare: v.boolean(),
    worktrees: v.boolean(),
    changes: v.boolean(),
  }),
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
  graphHideRemotes: v.boolean(),
  moveMainAfterFetch: v.boolean(),
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
const legacyLayouts: Record<string, ProjectLayout> = { project: "overview", folder: "changes" };

/** The layouts the key `layoutMode` of an earlier version held for its project's tab. */
const earlierLayout = v.picklist([
  "graph",
  "review",
  "worktrees",
  "settings",
  "changes",
  "overview",
]);

/**
 * The layout an earlier version's `layoutMode` showed in its project's tab: a layout as it was,
 * the project and folder views as the Overview and the Changes, the comparison as the graph (its
 * comparison comes back as a tab of its own); null when the file holds no such key.
 */
function launchLayoutOf(stored: unknown): ProjectLayout | null {
  if (typeof stored !== "string") return null;
  const legacy = legacyLayouts[stored];
  if (legacy) return legacy;
  if (stored === "compare") return "graph";
  const parsed = v.safeParse(earlierLayout, stored);
  return parsed.success ? parsed.output : null;
}

/** An earlier version's tabs of each project: its comparisons as compare tabs, its own tab as
 * `project`, the layout of which the launch resolves. */
function tabsOfEarlier(stored: unknown): Record<string, ProjectTabs> | null {
  const parsed = v.safeParse(v.record(v.string(), earlierProjectTabs), stored);
  if (!parsed.success) return null;
  return Object.fromEntries(
    Object.entries(parsed.output).map(([key, entry]) => [
      key,
      {
        open: entry.comparisons.map((pairOf) => ({ kind: "compare" as const, ...pairOf })),
        active: entry.active === 0 ? ("project" as const) : entry.active - 1,
      },
    ]),
  );
}

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
    tabs: {},
    sidebarSection: "local",
    // Review focus keeps the room for the diff: the rail alone.
    sidebarPanels: { graph: true, review: false, compare: true, worktrees: true, changes: true },
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
    graphHideRemotes: false,
    moveMainAfterFetch: false,
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

  /** The layout an earlier version left its open project's one tab on, until the launch shows
   * it (`takeLaunchLayout`); null when the file held none. */
  const launchLayout = ref<ProjectLayout | null>(null);

  /** Reads every key from `backend`; invalid or missing keys keep their default. Values
   * updated before the read finished win over the stored ones and are written through. The
   * keys of a version before projects land in `legacy`, and its project and folder views map
   * to the Overview and the Changes. An earlier version's tabs turn into the tabs of each
   * project, and its `layoutMode` into `launchLayout`, the key leaving the file. */
  async function init(backend: SettingsStorage, forPlatform = platform.value): Promise<void> {
    platform.value = forPlatform;
    const next = defaultSettings(forPlatform);
    const stored = await Promise.all(settingsKeys.map((key) => backend.get<unknown>(key)));
    const layout = await backend.get<unknown>("layoutMode");
    settingsKeys.forEach((key, index) => {
      const parsed = v.safeParse(schemas[key], stored[index]);
      if (parsed.success) (next as unknown as Record<string, unknown>)[key] = parsed.output;
    });
    const earlier = tabsOfEarlier(stored[settingsKeys.indexOf("tabs")]);
    if (earlier && !pending.has("tabs")) pending.set("tabs", earlier);
    launchLayout.value = launchLayoutOf(layout);
    const comparison = await readComparison(backend, layout === "compare", next);
    const legacyLayout = typeof layout === "string" && layout in legacyLayouts ? layout : null;
    legacy.value = await readLegacy(backend, legacyLayout as "project" | "folder" | null);
    for (const [key, value] of pending) (next as unknown as Record<string, unknown>)[key] = value;
    values.value = next;
    storage = backend;
    loaded.value = true;
    const retired = layout !== undefined;
    if (retired) await backend.delete("layoutMode");
    if (pending.size > 0) await flush();
    else if (comparison || retired) await backend.save();
  }

  /** The layout an earlier version left its open project on, once: the launch shows its tab. */
  function takeLaunchLayout(): ProjectLayout | null {
    const layout = launchLayout.value;
    launchLayout.value = null;
    return layout;
  }

  /**
   * A file holding one comparison (`compare`) beside the compare layout: the open project's first
   * comparison tab, shown; the key goes from the file. A comparison stored with another layout
   * had been left, and goes. True when the key was there.
   */
  async function readComparison(
    backend: SettingsStorage,
    shown: boolean,
    next: Settings,
  ): Promise<boolean> {
    const stored = await backend.get<unknown>("compare");
    if (stored === undefined) return false;
    const parsed = v.safeParse(pair, stored);
    const project = next.activeProject;
    const tabs = (pending.get("tabs") as Settings["tabs"] | undefined) ?? next.tabs;
    if (shown && parsed.success && project !== null && !(String(project) in tabs)) {
      const entry: ProjectTabs = { open: [{ kind: "compare", ...parsed.output }], active: 0 };
      pending.set("tabs", { ...tabs, [String(project)]: entry });
    }
    await backend.delete("compare");
    return true;
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
    launchLayout,
    takeLaunchLayout,
    init,
    update,
    flush,
    dropLegacy,
    terminalTemplates,
    editorTemplates,
    editorLineTemplates,
  };
});
