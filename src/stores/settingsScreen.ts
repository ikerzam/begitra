// The settings screen's own state: the git
// executable's detection and probe, the shortcut capture with its refusals, and the About
// section's facts (the version, the log folder). The values themselves live in the settings
// store and apply at once; this store holds what the screen is doing about them.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import type { AppInfo } from "@/ipc/schemas";
import type { Platform } from "@/shortcuts/platform";
import { shortcutRegistry, type ShortcutBinding } from "@/shortcuts/registry";

import { useSettingsStore } from "./settings";
import { useToastsStore } from "./toasts";

/** The file manager on a folder, per platform: argv templates as `open_external` takes them. */
export function folderTemplates(platform: Platform): string[] {
  switch (platform) {
    case "windows":
      return ["explorer {path}"];
    case "macos":
      return ["open {path}"];
    default:
      return ["xdg-open {path}"];
  }
}

export type GitState = "idle" | "detecting" | "probing" | "ready" | "error";

/** One row of the Shortcuts column; paired keys ("next / previous") share one row. */
export interface ShortcutRow {
  /** i18n suffix (`settings.shortcuts.<key>`). */
  key: string;
  /** The binding ids each `kbd` of the row stands for; a change captures one key per group. */
  groups: string[][];
}

/** The rows of the Shortcuts column, top to bottom. */
export const shortcutRows: readonly ShortcutRow[] = [
  { key: "palette", groups: [["palette"]] },
  { key: "graphFocus", groups: [["graph-focus"]] },
  { key: "reviewFocus", groups: [["review-focus"]] },
  { key: "changesFocus", groups: [["changes-focus"]] },
  { key: "toggleSidebar", groups: [["toggle-sidebar"]] },
  { key: "diffFrom", groups: [["diff-from"]] },
  { key: "compareWith", groups: [["compare-with"]] },
  {
    key: "nextPreviousCommitOrFile",
    groups: [
      ["next-row", "next-file"],
      ["previous-row", "previous-file"],
    ],
  },
  { key: "nextPreviousHunk", groups: [["next-hunk"], ["previous-hunk"]] },
  { key: "markReviewed", groups: [["mark-reviewed"]] },
  { key: "wholeFile", groups: [["toggle-whole-file"]] },
  { key: "stageUnstageFile", groups: [["stage-file"], ["unstage-file"]] },
  { key: "discardFile", groups: [["discard-file"]] },
  { key: "commit", groups: [["commit"]] },
  { key: "push", groups: [["push"]] },
  { key: "markResolved", groups: [["mark-resolved"]] },
  { key: "openTerminal", groups: [["open-terminal"]] },
  { key: "openEditor", groups: [["open-editor"]] },
  { key: "openFileEditor", groups: [["open-file-editor"]] },
  { key: "addWorktree", groups: [["add-worktree"]] },
  {
    key: "nextPreviousProjectRepo",
    groups: [["next-project-repo"], ["previous-project-repo"]],
  },
  { key: "settings", groups: [["settings"]] },
  { key: "zoom", groups: [["zoom-in"], ["zoom-out"], ["zoom-reset"]] },
];

export type CaptureRefusal =
  { kind: "plain" } | { kind: "taken"; by: string } | { kind: "modifier-only" };

/** The keys a keydown names, in the registry's notation; null for a lone modifier. */
export function keysOf(event: KeyboardEvent, platform: string): string | null {
  const key = event.key.toLowerCase();
  if (["control", "shift", "alt", "meta", "os"].includes(key)) return null;
  const parts: string[] = [];
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (platform === "macos" ? event.metaKey : event.ctrlKey) parts.push("mod");
  parts.push(key === " " ? " " : key);
  return parts.join("+");
}

export const useSettingsScreenStore = defineStore("settingsScreen", () => {
  const settings = useSettingsStore();
  const toasts = useToastsStore();

  const gitState = ref<GitState>("idle");
  /** The version and the log file, once asked (the About section). */
  const appInfo = ref<AppInfo | null>(null);
  const appInfoState = ref<"pending" | "loaded" | "failed">("pending");
  const gitVersion = ref<string | null>(null);
  const gitError = ref<AppError | null>(null);
  let gitSerial = 0;

  /** The ids of the groups being captured, the current one first; null when not capturing. */
  const capturing = ref<{ row: ShortcutRow; group: number } | null>(null);
  const refusal = ref<CaptureRefusal | null>(null);

  const executable = computed(() => settings.values.gitExecutable ?? "");

  function settleGit(mine: number, result: Promise<{ path: string; version: string }>) {
    return result
      .then((detected) => {
        if (mine !== gitSerial) return null;
        gitState.value = "ready";
        gitVersion.value = detected.version;
        gitError.value = null;
        return detected;
      })
      .catch((error: unknown) => {
        if (mine !== gitSerial) return null;
        gitState.value = "error";
        gitVersion.value = null;
        gitError.value = toAppError(error);
        return null;
      });
  }

  /** Probes the configured executable (or PATH's git) for its version line. */
  async function probe(): Promise<void> {
    gitSerial += 1;
    const mine = gitSerial;
    gitState.value = "probing";
    await settleGit(mine, ipc.setGitExecutable(executable.value));
  }

  /** "Detect": looks for git and stores the path it finds. */
  async function detect(): Promise<void> {
    gitSerial += 1;
    const mine = gitSerial;
    gitState.value = "detecting";
    const detected = await settleGit(mine, ipc.detectGit());
    if (detected) {
      void settings.update("gitExecutable", detected.path === "git" ? null : detected.path);
    }
  }

  /** The user typed a path: it is stored as typed and the CLI switches to it if it runs. */
  async function applyExecutable(path: string): Promise<void> {
    const trimmed = path.trim();
    // The store's flush is not waited for: the probe answers first.
    void settings.update("gitExecutable", trimmed === "" ? null : trimmed);
    gitSerial += 1;
    const mine = gitSerial;
    gitState.value = "probing";
    await settleGit(mine, ipc.setGitExecutable(trimmed));
  }

  /** Asks the backend for the version and the log file; a failure reads "unavailable". */
  async function loadAppInfo(): Promise<void> {
    try {
      appInfo.value = await ipc.appInfo();
      appInfoState.value = "loaded";
    } catch {
      appInfo.value = null;
      appInfoState.value = "failed";
    }
  }

  /** "Open logs folder": the file manager of the platform the settings store knows. */
  async function openLogsFolder(platform: Platform = settings.platform): Promise<boolean> {
    const dir = appInfo.value?.logDir;
    if (!dir) return false;
    try {
      await ipc.openExternal(folderTemplates(platform), dir);
      return true;
    } catch (failure) {
      const error = toAppError(failure);
      toasts.push({
        kind: "error",
        message: "",
        key: "settings.about.openFailed",
        params: { path: dir },
        output: error.detail ?? error.message,
      });
      return false;
    }
  }

  /** At launch: the stored executable takes over the CLI, or the error state shows why not. */
  async function applyAtLaunch(): Promise<void> {
    if (settings.values.gitExecutable === null) return;
    await probe();
  }

  /** The overrides of the settings, onto the registry. */
  function applyOverrides(): void {
    const registry = shortcutRegistry();
    for (const [id, keys] of Object.entries(settings.values.shortcuts)) {
      if (registry.binding(id)) registry.rebind(id, keys);
    }
  }

  function bindingOf(id: string): ShortcutBinding | undefined {
    return shortcutRegistry().binding(id);
  }

  /** The keys a group is bound to now (its first id speaks for all). */
  function keysOfGroup(group: string[]): string {
    const first = group[0];
    return (first && bindingOf(first)?.keys) ?? "";
  }

  function startCapture(row: ShortcutRow): void {
    capturing.value = { row, group: 0 };
    refusal.value = null;
  }

  function cancelCapture(): void {
    capturing.value = null;
    refusal.value = null;
  }

  /** The id whose binding holds `keys`, other than the ones being changed. */
  function takenBy(keys: string, own: string[]): string | null {
    const registry = shortcutRegistry();
    for (const binding of registry.list()) {
      if (own.includes(binding.id)) continue;
      if (binding.keys === keys) return binding.id;
    }
    return null;
  }

  /** A keydown while capturing: the group takes the keys, or the refusal says why not. */
  function captured(event: KeyboardEvent): void {
    const current = capturing.value;
    if (!current) return;
    if (event.key === "Escape") {
      cancelCapture();
      return;
    }
    const keys = keysOf(event, shortcutRegistry().platform);
    if (keys === null) {
      refusal.value = { kind: "modifier-only" };
      return;
    }
    const group = current.row.groups[current.group] ?? [];
    const scope = group[0] ? bindingOf(group[0])?.scope : undefined;
    if (!keys.includes("+") && scope === "global") {
      refusal.value = { kind: "plain" };
      return;
    }
    const owner = takenBy(keys, current.row.groups.flat());
    if (owner) {
      refusal.value = { kind: "taken", by: owner };
      return;
    }
    const overrides = { ...settings.values.shortcuts };
    for (const id of group) {
      shortcutRegistry().rebind(id, keys);
      if (shortcutRegistry().defaultKeys(id) === keys) delete overrides[id];
      else overrides[id] = keys;
    }
    refusal.value = null;
    const next = current.group + 1;
    capturing.value = next < current.row.groups.length ? { row: current.row, group: next } : null;
    void settings.update("shortcuts", overrides);
  }

  /** "Reset": every id of the row returns to its default. */
  function reset(row: ShortcutRow): void {
    const registry = shortcutRegistry();
    const overrides = { ...settings.values.shortcuts };
    for (const id of row.groups.flat()) {
      const keys = registry.defaultKeys(id);
      if (keys) registry.rebind(id, keys);
      delete overrides[id];
    }
    cancelCapture();
    void settings.update("shortcuts", overrides);
  }

  /** The row a binding id belongs to, for naming the owner of a taken chord. */
  function rowOf(id: string): ShortcutRow | undefined {
    return shortcutRows.find((row) => row.groups.flat().includes(id));
  }

  /** Whether any id of the row is overridden. */
  function isOverridden(row: ShortcutRow): boolean {
    return row.groups.flat().some((id) => id in settings.values.shortcuts);
  }

  return {
    gitState,
    gitVersion,
    gitError,
    executable,
    capturing,
    refusal,
    appInfo,
    appInfoState,
    loadAppInfo,
    openLogsFolder,
    probe,
    detect,
    applyExecutable,
    applyAtLaunch,
    applyOverrides,
    keysOfGroup,
    startCapture,
    cancelCapture,
    captured,
    reset,
    isOverridden,
    rowOf,
  };
});
