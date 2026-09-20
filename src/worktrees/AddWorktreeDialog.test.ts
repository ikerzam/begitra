import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  fakeBackend,
  fakeWorktrees,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

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

const input = (wrapper: ReturnType<typeof mountWithI18n>, id: string) =>
  wrapper.get<HTMLInputElement>(`[data-testid="${id}"] input, input[data-testid="${id}"]`);

describe("AddWorktreeDialog", () => {
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
      branch: { kind: "new", name: "claude/fix-tiles", start: "main" },
    });
    expect(useWorktreesStore().selectedPath).toBe("/r.worktrees/claude-fix-tiles");
    expect(useWorktreesStore().rows).toHaveLength(4);
  });

  it("keeps the dialog open with git's output when the add fails, and refuses an existing folder", async () => {
    const { wrapper } = await mountDialog({ failWorktreeAdd: true, existingPaths: ["/taken"] });
    const dialog = wrapper.get('[role="dialog"]');
    const branch = dialog.get<HTMLSelectElement>("select");
    await branch.setValue("develop");
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
