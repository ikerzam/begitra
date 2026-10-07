import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutRegistry, setShortcutRegistry, shortcutRegistry } from "@/shortcuts/registry";
import { fakeBackend, settled } from "@/test/backend";

import { memoryStorage, useSettingsStore } from "./settings";
import { keysOf, shortcutRows, useSettingsScreenStore } from "./settingsScreen";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

const row = (key: string) => {
  const found = shortcutRows.find((candidate) => candidate.key === key);
  if (!found) throw new Error(key);
  return found;
};

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  setShortcutRegistry(undefined);
  clearMocks();
});

describe("keysOf", () => {
  it("names the chord in the registry's notation and ignores lone modifiers", () => {
    expect(keysOf(key({ key: "t", ctrlKey: true, shiftKey: true }), "windows")).toBe("shift+mod+t");
    expect(keysOf(key({ key: "T", metaKey: true }), "macos")).toBe("mod+t");
    expect(keysOf(key({ key: "k", metaKey: true }), "windows")).toBe("k");
    expect(keysOf(key({ key: "Control", ctrlKey: true }), "windows")).toBeNull();
    expect(keysOf(key({ key: ",", ctrlKey: true }), "windows")).toBe("mod+,");
  });

  it("writes Control as ctrl on macOS, where ⌘ is mod", () => {
    expect(keysOf(key({ key: "Tab", ctrlKey: true }), "macos")).toBe("ctrl+tab");
    expect(keysOf(key({ key: "Tab", ctrlKey: true, shiftKey: true }), "macos")).toBe(
      "shift+ctrl+tab",
    );
    expect(keysOf(key({ key: "w", ctrlKey: true, metaKey: true }), "macos")).toBe("ctrl+mod+w");
    expect(keysOf(key({ key: "Tab", ctrlKey: true }), "windows")).toBe("mod+tab");
  });
});

describe("settings screen store", () => {
  it("detects git, stores the path and reads the version", async () => {
    fakeBackend();
    const screen = useSettingsScreenStore();
    const settings = useSettingsStore();
    expect(screen.gitState).toBe("idle");
    const detecting = screen.detect();
    expect(screen.gitState).toBe("detecting");
    await detecting;
    await settled();
    expect(screen.gitState).toBe("ready");
    expect(screen.gitVersion).toBe("git version 2.46.0");
    expect(settings.values.gitExecutable).toBe("/usr/bin/git");
    expect(screen.executable).toBe("/usr/bin/git");
  });

  it("keeps a wrong executable typed by the user in the error state and PATH's git in use", async () => {
    const calls = fakeBackend();
    const screen = useSettingsScreenStore();
    const settings = useSettingsStore();
    await screen.applyExecutable("/opt/bin/gti");
    await settled();
    expect(screen.gitState).toBe("error");
    expect(screen.gitError?.code).toBe("git.cli_failed");
    expect(settings.values.gitExecutable).toBe("/opt/bin/gti");
    expect(calls.at(-1)?.cmd).toBe("set_git_executable");
    // An empty field returns to PATH's git.
    await screen.applyExecutable("  ");
    await settled();
    expect(settings.values.gitExecutable).toBeNull();
    expect(screen.gitState).toBe("ready");
  });

  it("probes the stored executable at launch and stays idle without one", async () => {
    const calls = fakeBackend();
    const screen = useSettingsScreenStore();
    await screen.applyAtLaunch();
    expect(calls.some((call) => call.cmd === "set_git_executable")).toBe(false);
    expect(screen.gitState).toBe("idle");
    await useSettingsStore().update("gitExecutable", "/usr/bin/git");
    await screen.applyAtLaunch();
    await settled();
    expect(screen.gitState).toBe("ready");
  });

  it("captures a chord for a row, refuses plain keys and taken chords, and resets", async () => {
    fakeBackend();
    const screen = useSettingsScreenStore();
    const settings = useSettingsStore();
    const registry = shortcutRegistry();
    screen.startCapture(row("openTerminal"));
    expect(screen.capturing?.row.key).toBe("openTerminal");
    screen.captured(key({ key: "Control", ctrlKey: true }));
    expect(screen.refusal).toEqual({ kind: "modifier-only" });
    screen.captured(key({ key: "x" }));
    expect(screen.refusal).toEqual({ kind: "plain" });
    screen.captured(key({ key: "k", ctrlKey: true }));
    expect(screen.refusal).toEqual({ kind: "taken", by: "palette" });
    expect(registry.binding("open-terminal")?.keys).toBe("mod+t");
    screen.captured(key({ key: "t", ctrlKey: true, shiftKey: true }));
    await settled();
    expect(screen.capturing).toBeNull();
    expect(screen.refusal).toBeNull();
    expect(registry.binding("open-terminal")?.keys).toBe("shift+mod+t");
    expect(registry.hint("open-terminal")).toBe("Ctrl Shift T");
    expect(settings.values.shortcuts).toEqual({ "open-terminal": "shift+mod+t" });
    expect(screen.isOverridden(row("openTerminal"))).toBe(true);
    // Back to the default: the override goes.
    screen.reset(row("openTerminal"));
    expect(registry.binding("open-terminal")?.keys).toBe("mod+t");
    expect(settings.values.shortcuts).toEqual({});
    expect(screen.isOverridden(row("openTerminal"))).toBe(false);
  });

  it("knows a chord written another way: taken by its binding, and no override of its own", async () => {
    fakeBackend();
    const screen = useSettingsScreenStore();
    const settings = useSettingsStore();
    const registry = shortcutRegistry();
    // On Windows the capture writes Ctrl Tab as `mod+tab`; next-tab holds it as `ctrl+tab`.
    screen.startCapture(row("openTerminal"));
    screen.captured(key({ key: "Tab", ctrlKey: true }));
    expect(screen.refusal).toEqual({ kind: "taken", by: "next-tab" });
    screen.cancelCapture();
    screen.startCapture(row("nextPreviousTab"));
    screen.captured(key({ key: "Tab", ctrlKey: true }));
    screen.captured(key({ key: "Tab", ctrlKey: true, shiftKey: true }));
    await settled();
    expect(screen.capturing).toBeNull();
    expect(settings.values.shortcuts).toEqual({});
    expect(registry.binding("next-tab")?.keys).toBe("ctrl+tab");
    expect(registry.hint("previous-tab")).toBe("Ctrl Shift Tab");
  });

  it("captures the two keys of a next/previous row in turn, for every id of each group", async () => {
    fakeBackend();
    const screen = useSettingsScreenStore();
    const registry = shortcutRegistry();
    const pair = row("nextPreviousCommitOrFile");
    screen.startCapture(pair);
    // A plain key is fine for the list and review scopes, but `n` is the hunk key already.
    screen.captured(key({ key: "n" }));
    expect(screen.refusal).toEqual({ kind: "taken", by: "next-hunk" });
    expect(screen.capturing).toEqual({ row: pair, group: 0 });
    expect(registry.binding("next-row")?.keys).toBe("j");
    screen.captured(key({ key: "ArrowDown" }));
    expect(screen.refusal).toBeNull();
    expect(screen.capturing).toEqual({ row: pair, group: 1 });
    screen.captured(key({ key: "ArrowUp" }));
    await settled();
    expect(screen.capturing).toBeNull();
    expect(registry.binding("next-row")?.keys).toBe("arrowdown");
    expect(registry.binding("next-file")?.keys).toBe("arrowdown");
    expect(registry.binding("previous-row")?.keys).toBe("arrowup");
    expect(screen.keysOfGroup(["next-row", "next-file"])).toBe("arrowdown");
    expect(useSettingsStore().values.shortcuts).toEqual({
      "next-row": "arrowdown",
      "next-file": "arrowdown",
      "previous-row": "arrowup",
      "previous-file": "arrowup",
    });
  });

  it("applies the stored overrides to the registry and ignores unknown ids", async () => {
    fakeBackend();
    await useSettingsStore().update("shortcuts", {
      "open-editor": "shift+mod+e",
      "no-such-binding": "mod+x",
    });
    const screen = useSettingsScreenStore();
    screen.applyOverrides();
    expect(shortcutRegistry().binding("open-editor")?.keys).toBe("shift+mod+e");
    expect(shortcutRegistry().binding("no-such-binding")).toBeUndefined();
  });
});
