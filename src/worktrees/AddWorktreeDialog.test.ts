import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useWorktreesStore, type AddPreset } from "@/stores/worktrees";
import {
  fakeBackend,
  fakeWorktrees,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { mountWithI18n } from "@/test/mount";
import { chooseOption, optionLabels } from "@/test/select";
import { useShellStore } from "@/stores/shell";
import { useToastsStore } from "@/stores/toasts";

import AddWorktreeDialog from "./AddWorktreeDialog.vue";

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

async function mountDialog(options: FakeBackendOptions = {}): Promise<{
  wrapper: ReturnType<typeof mountWithI18n>;
  calls: Call[];
}> {
  const calls = fakeBackend({ worktrees: fakeWorktrees(), ...options });
  await useRepoStore().open("/r");
  await settled();
  await useWorktreesStore().show();
  await settled();
  useWorktreesStore().openAdd();
  const wrapper = mountWithI18n(AddWorktreeDialog, { attachTo: document.body });
  await flushPromises();
  await nextTick();
  return { wrapper, calls };
}

/** The dialog as a branch's "New worktree…" opens it. */
async function mountPreset(preset: AddPreset): Promise<{
  wrapper: ReturnType<typeof mountWithI18n>;
  calls: Call[];
}> {
  const calls = fakeBackend({ worktrees: fakeWorktrees() });
  await useRepoStore().open("/r");
  await settled();
  useWorktreesStore().openAdd(preset);
  const wrapper = mountWithI18n(AddWorktreeDialog, { attachTo: document.body });
  await flushPromises();
  await nextTick();
  return { wrapper, calls };
}

async function submitted(wrapper: ReturnType<typeof mountWithI18n>, calls: Call[]) {
  await settled();
  await wrapper.get('[data-testid="dialog-confirm"]').trigger("click");
  await settled();
  await flushPromises();
  return calls.find((call) => call.cmd === "worktree_add")?.args["request"];
}

const input = (wrapper: ReturnType<typeof mountWithI18n>, id: string) =>
  wrapper.get<HTMLInputElement>(`[data-testid="${id}"] input, input[data-testid="${id}"]`);

describe("AddWorktreeDialog", () => {
  it("starts on the free branch a branch's New worktree… names, and adds it as it is", async () => {
    const { wrapper, calls } = await mountPreset({ kind: "existing", branch: "develop" });
    expect(wrapper.find('[data-testid="add-worktree-name"]').exists()).toBe(false);
    // The branch is picked already: the path takes the focus, where ↵ adds.
    expect(document.activeElement).toBe(input(wrapper, "add-worktree-path").element);
    expect(input(wrapper, "add-worktree-path").element.value).toBe("/r.worktrees/develop");
    expect(await submitted(wrapper, calls)).toEqual({
      path: "/r.worktrees/develop",
      branch: { kind: "existing", name: "develop" },
    });
  });

  it("says where the worktree went when the dashboard is not shown, with Open worktree", async () => {
    const { wrapper, calls } = await mountPreset({ kind: "existing", branch: "develop" });
    expect(useShellStore().layoutMode).not.toBe("worktrees");
    expect(await submitted(wrapper, calls)).toBeDefined();
    const toast = useToastsStore().toasts.at(-1);
    expect(toast).toMatchObject({
      key: "worktrees.added",
      params: { folder: "develop" },
      actionKey: "worktrees.open",
    });
    // "Open" opens the new worktree as the context.
    toast?.onAction?.();
    await settled();
    expect(
      calls.some(
        (call) => call.cmd === "open_repository" && call.args["path"] === "/r.worktrees/develop",
      ),
    ).toBe(true);
  });

  it("starts a new branch that tracks a remote branch, said under Start from", async () => {
    const { wrapper, calls } = await mountPreset({
      kind: "new",
      start: "refs/remotes/origin/feature/map",
      name: "feature/map",
      track: true,
    });
    expect(input(wrapper, "add-worktree-name").element.value).toBe("feature/map");
    expect(wrapper.get('[data-testid="add-worktree-tracks"]').text()).toBe(
      "Tracks origin/feature/map",
    );
    expect(input(wrapper, "add-worktree-path").element.value).toBe("/r.worktrees/feature-map");
    // The remote start leads Start from's choices.
    expect((await optionLabels(wrapper.get('[data-testid="add-worktree-start"]')))[0]).toBe(
      "origin/feature/map",
    );
    expect(await submitted(wrapper, calls)).toEqual({
      path: "/r.worktrees/feature-map",
      branch: {
        kind: "new",
        name: "feature/map",
        start: "refs/remotes/origin/feature/map",
        track: true,
      },
    });
  });

  it("tracks the remote branch under its own name only, and starts a held branch's new branch empty", async () => {
    const renamed = await mountPreset({
      kind: "new",
      start: "refs/remotes/origin/feature/map",
      name: "feature/map",
      track: true,
    });
    // Another name tracks nothing (Begitra pushes a branch under its own name only).
    await input(renamed.wrapper, "add-worktree-name").setValue("feature/map-2");
    await nextTick();
    expect(renamed.wrapper.find('[data-testid="add-worktree-tracks"]').exists()).toBe(false);
    expect(await submitted(renamed.wrapper, renamed.calls)).toEqual({
      path: "/r.worktrees/feature-map-2",
      branch: {
        kind: "new",
        name: "feature/map-2",
        start: "refs/remotes/origin/feature/map",
        track: false,
      },
    });
    renamed.wrapper.unmount();
    clearMocks();
    setActivePinia(createPinia());
    await useSettingsStore().init(memoryStorage(), "windows");
    const tracked = await mountPreset({
      kind: "new",
      start: "refs/remotes/origin/feature/map",
      name: "feature/map",
      track: true,
    });
    // Another start: git's setting decides, nothing asked.
    await chooseOption(
      tracked.wrapper.get('[data-testid="add-worktree-start"]'),
      "refs/heads/main",
    );
    expect(tracked.wrapper.find('[data-testid="add-worktree-tracks"]').exists()).toBe(false);
    expect(await submitted(tracked.wrapper, tracked.calls)).toEqual({
      path: "/r.worktrees/feature-map",
      branch: { kind: "new", name: "feature/map", start: "refs/heads/main" },
    });
    tracked.wrapper.unmount();
    clearMocks();
    setActivePinia(createPinia());
    await useSettingsStore().init(memoryStorage(), "windows");
    const held = await mountPreset({
      kind: "new",
      start: "refs/heads/main",
      name: "",
      track: false,
    });
    expect(input(held.wrapper, "add-worktree-name").element.value).toBe("");
    expect(held.wrapper.find('[data-testid="add-worktree-tracks"]').exists()).toBe(false);
    expect(held.wrapper.get('[data-testid="dialog-confirm"]').attributes("disabled")).toBeDefined();
    await input(held.wrapper, "add-worktree-name").setValue("main-2");
    expect(await submitted(held.wrapper, held.calls)).toEqual({
      path: "/r.worktrees/main-2",
      branch: { kind: "new", name: "main-2", start: "refs/heads/main" },
    });
  });

  it("adds a worktree from the dialog with the default path and selects the new row", async () => {
    const { wrapper, calls } = await mountDialog();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain("Add worktree");
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("disabled")).toBeDefined();
    await dialog
      .get('[data-testid="add-worktree-name"] input, input[data-testid="add-worktree-name"]')
      .setValue("claude/fix-tiles");
    await nextTick();
    const path = dialog.get<HTMLInputElement>(
      '[data-testid="add-worktree-path"] input, input[data-testid="add-worktree-path"]',
    );
    expect(path.element.value).toBe("/r.worktrees/claude-fix-tiles");
    expect(dialog.get('[data-testid="add-worktree-help"]').text()).toBe(
      "Defaults to /r.worktrees/‹branch›. The folder must not exist yet.",
    );
    await settled();
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("disabled")).toBeUndefined();
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(1);
    const add = calls.find((call) => call.cmd === "worktree_add");
    expect(add?.args["request"]).toEqual({
      path: "/r.worktrees/claude-fix-tiles",
      branch: { kind: "new", name: "claude/fix-tiles", start: "refs/heads/main" },
    });
    expect(useWorktreesStore().selectedPath).toBe("/r.worktrees/claude-fix-tiles");
    expect(useWorktreesStore().rows).toHaveLength(4);
  });

  it("keeps the dialog open with git's output when the add fails, and refuses an existing folder", async () => {
    const { wrapper } = await mountDialog({ failWorktreeAdd: true, existingPaths: ["/taken"] });
    const dialog = wrapper.get('[role="dialog"]');
    await chooseOption(dialog.get('[data-testid="add-worktree-branch"]'), "develop");
    await nextTick();
    expect(dialog.find('[data-testid="add-worktree-start"]').exists()).toBe(false);
    const path = dialog.get<HTMLInputElement>(
      '[data-testid="add-worktree-path"] input, input[data-testid="add-worktree-path"]',
    );
    expect(path.element.value).toBe("/r.worktrees/develop");
    await path.setValue("/taken");
    await settled();
    expect(dialog.text()).toContain("The folder must not exist yet.");
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("disabled")).toBeDefined();
    await path.setValue("/free");
    await settled();
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    await flushPromises();
    expect(wrapper.emitted("close")).toBeUndefined();
    const banner = wrapper.get('[data-testid="add-worktree-error"]');
    expect(banner.text()).toContain("git reported an error.");
    expect(banner.text()).toContain("already used by worktree");
  });

  it("cancels with Escape and from the button", async () => {
    const { wrapper } = await mountDialog();
    await input(wrapper, "add-worktree-name").trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    await wrapper.get('[data-testid="dialog-cancel"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(2);
  });
});
