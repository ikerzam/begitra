import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { defaultSkipFolders } from "@/ipc/commands";
import { ShortcutRegistry, setShortcutRegistry, shortcutRegistry } from "@/shortcuts/registry";
import { useIndexStore } from "@/stores/index";
import { useReviewStore } from "@/stores/review";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useSettingsScreenStore } from "@/stores/settingsScreen";
import { fakeBackend, settled, type FakeBackendOptions } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import SettingsLayout from "./SettingsLayout.vue";

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

async function mountSettings(options: FakeBackendOptions = {}) {
  fakeBackend(options);
  const wrapper = mountWithI18n(SettingsLayout, { attachTo: document.body });
  await flushPromises();
  await nextTick();
  return wrapper;
}

const input = (wrapper: ReturnType<typeof mountWithI18n>, id: string) =>
  wrapper.get<HTMLInputElement>(`input[data-testid="${id}"]`);

describe("SettingsLayout", () => {
  it("shows the title, the sections, the empty scan folders and the shortcut rows", async () => {
    const wrapper = await mountSettings();
    expect(wrapper.get("h1").text()).toBe("Settings");
    expect(wrapper.text()).toContain("Changes apply immediately and are stored on this machine.");
    expect(wrapper.findAll("h2").map((h) => h.text())).toEqual([
      "Discovery",
      "Git",
      "Terminal and editor",
      "Diff",
      "Shortcuts",
    ]);
    expect(wrapper.get('[data-testid="scan-folders-empty"]').text()).toBe(
      "No folders yet. Begira scans these for repositories and worktrees.",
    );
    expect(input(wrapper, "skip-folders").element.value).toBe(defaultSkipFolders.join(", "));
    expect(input(wrapper, "max-depth").element.value).toBe("6");
    const rows = wrapper.findAll('[data-testid="shortcut-rows"] li');
    expect(rows).toHaveLength(19);
    expect(rows[0]?.text()).toContain("Command palette");
    expect(rows[0]?.find("kbd").text()).toBe("Ctrl K");
    const pair = wrapper.get('[data-testid="shortcut-nextPreviousCommitOrFile"]');
    expect(pair.findAll("kbd").map((k) => k.text())).toEqual(["j", "k"]);
    const staging = wrapper.get('[data-testid="shortcut-stageUnstageFile"]');
    expect(staging.findAll("kbd").map((k) => k.text())).toEqual(["s", "u"]);
    expect(wrapper.get('[data-testid="shortcut-commit"]').find("kbd").text()).toBe("Ctrl ↵");
    expect(wrapper.text()).toContain(
      "Shortcuts follow the platform: ⌘ is Ctrl on Windows and Linux.",
    );
  });

  it("lists the scan folders with their counts and removes one", async () => {
    const wrapper = await mountSettings();
    const settings = useSettingsStore();
    await settings.update("scanRoots", ["/code", "/wt"]);
    await useIndexStore().load();
    await settled();
    await nextTick();
    const rows = wrapper.findAll('[data-testid="scan-folder"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text()).toContain("/code");
    expect(rows[0]?.get('[data-testid="scan-folder-count"]').text()).toBe("0 repositories");
    await rows[1]!.get('[data-testid="scan-folder-remove"]').trigger("click");
    await settled();
    expect(settings.values.scanRoots).toEqual(["/code"]);
  });

  it("commits the text fields on blur and Enter, splitting and clamping", async () => {
    const wrapper = await mountSettings();
    const settings = useSettingsStore();
    const skip = input(wrapper, "skip-folders");
    await skip.setValue(" node_modules , dist,, ");
    expect(settings.values.skipFolders).toEqual([...defaultSkipFolders]);
    await skip.trigger("blur");
    expect(settings.values.skipFolders).toEqual(["node_modules", "dist"]);
    const depth = input(wrapper, "max-depth");
    await depth.setValue("99");
    await depth.trigger("keydown", { key: "Enter" });
    expect(settings.values.maxDepth).toBe(32);
    await depth.setValue("abc");
    await depth.trigger("blur");
    expect(settings.values.maxDepth).toBe(32);
    const terminal = input(wrapper, "terminal-command");
    await terminal.setValue("wezterm start --cwd {path}");
    await terminal.trigger("blur");
    expect(settings.values.terminalCommand).toBe("wezterm start --cwd {path}");
    // Escape restores the stored value.
    await terminal.setValue("garbage");
    await terminal.trigger("keydown", { key: "Escape" });
    expect(terminal.element.value).toBe("wezterm start --cwd {path}");
  });

  it("detects git with the loading line, then shows the version", async () => {
    const wrapper = await mountSettings();
    await wrapper.get('[data-testid="git-detect"]').trigger("click");
    expect(wrapper.get('[data-testid="git-detecting"]').text()).toContain(
      "Looking for git on PATH and in common locations",
    );
    expect(input(wrapper, "git-executable").attributes("placeholder")).toBe("Detecting…");
    await settled();
    await nextTick();
    expect(wrapper.get('[data-testid="git-version"]').text()).toBe("git version 2.46.0");
    expect(input(wrapper, "git-executable").element.value).toBe("/usr/bin/git");
  });

  it("shows the error state for a path that is not git", async () => {
    const wrapper = await mountSettings();
    const field = input(wrapper, "git-executable");
    await field.setValue("/opt/bin/gti");
    await field.trigger("blur");
    await settled();
    await nextTick();
    expect(field.attributes("aria-invalid")).toBe("true");
    expect(wrapper.text()).toContain(
      "Not a git executable. Begira needs git 2.30 or newer; the path above does not run.",
    );
    expect(useSettingsScreenStore().gitState).toBe("error");
  });

  it("writes the diff settings at once and the review follows them", async () => {
    const wrapper = await mountSettings();
    const settings = useSettingsStore();
    const review = useReviewStore();
    await wrapper.get('[data-testid="diff-side-by-side"]').trigger("click");
    expect(settings.values.diffLayout).toBe("side-by-side");
    await wrapper.get('[data-testid="diff-wrap"]').trigger("click");
    expect(settings.values.diffWrap).toBe(true);
    await wrapper.get('[data-testid="tab-width"] select').setValue("8");
    expect(settings.values.tabWidth).toBe(8);
    expect(review.tabWidth).toBe(8);
    await wrapper.get('[data-testid="hide-tests"] input').setValue(true);
    expect(settings.values.hideByDefault).toEqual({
      generated: true,
      lockfiles: true,
      tests: true,
    });
    await nextTick();
    expect(review.filters.hideTests).toBe(true);
  });

  it("changes a shortcut from its row, refuses a taken chord and resets", async () => {
    const wrapper = await mountSettings();
    const row = wrapper.get('[data-testid="shortcut-openTerminal"]');
    await row.get('[data-testid="shortcut-change"]').trigger("click");
    expect(row.get('[data-testid="shortcut-capturing"]').text()).toContain("Press the keys…");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true }),
    );
    await nextTick();
    expect(row.get('[data-testid="shortcut-refusal"]').text()).toBe(
      'Already used by "Command palette".',
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "t", ctrlKey: true, shiftKey: true, cancelable: true }),
    );
    await settled();
    await nextTick();
    expect(row.find('[data-testid="shortcut-capturing"]').exists()).toBe(false);
    expect(row.get("kbd").text()).toBe("Ctrl Shift T");
    expect(shortcutRegistry().binding("open-terminal")?.keys).toBe("shift+mod+t");
    await row.get('[data-testid="shortcut-reset"]').trigger("click");
    await nextTick();
    expect(row.get("kbd").text()).toBe("Ctrl T");
    expect(row.find('[data-testid="shortcut-reset"]').exists()).toBe(false);
  });

  it("probes PATH's git on opening and shows its version", async () => {
    const wrapper = await mountSettings();
    expect(wrapper.get('[data-testid="git-version"]').text()).toBe("git version 2.46.0");
    expect(input(wrapper, "git-executable").element.value).toBe("");
  });

  it("restores an unparsable depth and lets go of a field on Escape", async () => {
    const wrapper = await mountSettings();
    const depth = input(wrapper, "max-depth");
    (depth.element as HTMLElement).focus();
    await depth.setValue("abc");
    await depth.trigger("blur");
    expect(depth.element.value).toBe("6");
    (depth.element as HTMLElement).focus();
    await depth.setValue("12");
    await depth.trigger("keydown", { key: "Escape" });
    expect(depth.element.value).toBe("6");
    expect(document.activeElement).not.toBe(depth.element);
  });

  it("keeps the focus on the row while a shortcut is captured", async () => {
    const wrapper = await mountSettings();
    const row = wrapper.get('[data-testid="shortcut-openEditor"]');
    const change = row.get('[data-testid="shortcut-change"]');
    (change.element as HTMLElement).focus();
    await change.trigger("click");
    await nextTick();
    expect(document.activeElement).toBe(row.get('[data-testid="shortcut-cancel"]').element);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(row.get('[data-testid="shortcut-change"]').element);
  });

  it("moves between the fields with j and k when no text field has the focus", async () => {
    const wrapper = await mountSettings();
    const add = wrapper.get('[data-testid="scan-folders-add"]');
    (add.element as HTMLElement).focus();
    await add.trigger("keydown", { key: "j" });
    expect(document.activeElement).toBe(input(wrapper, "skip-folders").element);
    // Inside the text field j types; blurring it and pressing k walks back.
    await input(wrapper, "skip-folders").trigger("keydown", { key: "k" });
    expect(document.activeElement).toBe(input(wrapper, "skip-folders").element);
    const detect = wrapper.get('[data-testid="git-detect"]');
    (detect.element as HTMLElement).focus();
    await detect.trigger("keydown", { key: "k" });
    expect(document.activeElement).toBe(input(wrapper, "git-executable").element);
  });
});
