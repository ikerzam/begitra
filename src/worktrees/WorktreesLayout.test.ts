import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useCompareStore } from "@/stores/compare";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  fakeBackend,
  fakeWorktrees,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import WorktreesLayout from "./WorktreesLayout.vue";

const summaries = {
  "/wt/claude-auth": {
    currentBranch: "claude/fix-auth",
    detached: false,
    ahead: null,
    behind: null,
    lastCommitAt: 1_699_000_000,
    upstream: null,
    operation: null,
    fetchedAt: null,
    dirty: true,
  },
};

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

async function mountDashboard(options: FakeBackendOptions = {}): Promise<{
  wrapper: ReturnType<typeof mountWithI18n>;
  calls: Call[];
}> {
  const calls = fakeBackend({ worktrees: fakeWorktrees(), summaries, ...options });
  await useRepoStore().open("/r");
  await settled();
  await useWorktreesStore().show();
  await settled();
  const wrapper = mountWithI18n(WorktreesLayout, { attachTo: document.body });
  await flushPromises();
  await nextTick();
  return { wrapper, calls };
}

function rows(wrapper: ReturnType<typeof mountWithI18n>) {
  return wrapper.findAll('[data-testid="worktree-row"]');
}

describe("WorktreesLayout", () => {
  it("resizes the path, branch, state and ahead/behind columns from their headers", async () => {
    const { wrapper } = await mountDashboard();
    const table = wrapper.get('[data-testid="worktree-table"]');
    expect(table.attributes("style")).toContain("--worktree-ahead-w: 84px");
    const edges = table.findAll('[data-testid="column-resizer"]');
    expect(edges).toHaveLength(4);
    const branch = edges[1]!;
    await branch.trigger("mousedown", { clientX: 400 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 480 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await flushPromises();
    expect(useSettingsStore().values.columnWidths.worktrees.branch).toBe(280);
    expect(table.attributes("style")).toContain("--worktree-branch-w: 280px");
    wrapper.unmount();
  });

  it("lists the worktrees as a grid: the main one first, states, counts and the footer", async () => {
    const { wrapper } = await mountDashboard();
    expect(wrapper.get('[data-testid="worktrees-count"]').text()).toBe("2");
    expect(wrapper.get('[role="grid"]').attributes("aria-label")).toBe("Worktrees");
    expect(wrapper.findAll('[role="columnheader"]').map((h) => h.text())).toEqual([
      "Path",
      "Branch",
      "State",
      "Ahead/behind",
      "Last commit",
      "Actions",
    ]);
    const listed = rows(wrapper);
    expect(listed).toHaveLength(3);
    expect(listed[0]?.attributes("role")).toBe("row");
    expect(listed[0]?.get('[data-testid="worktree-row-path"]').text()).toBe("/r");
    expect(listed[0]?.get('[data-testid="worktree-row-state"]').text()).toBe("main worktree");
    const linked = listed[1];
    expect(linked?.get('[data-testid="worktree-row-branch"]').text()).toBe("claude/fix-auth");
    expect(linked?.find('[data-testid="worktree-row-branch"] [role="img"]').exists()).toBe(true);
    expect(linked?.get('[data-testid="ahead"]').text()).toBe("3");
    expect(linked?.get('[data-testid="behind"]').text()).toBe("4");
    expect(linked?.get('[data-testid="worktree-row-commit"]').text()).toContain("commit 4");
    const gone = listed[2];
    expect(gone?.get('[data-testid="worktree-row-state"]').text()).toBe("Folder missing");
    expect(gone?.get('[data-testid="worktree-row-commit"]').text()).toBe(
      "Prune to remove this entry",
    );
    expect(wrapper.get('[data-testid="worktree-footer"]').text()).toContain(
      "Worktrees share the repository's objects.",
    );
    expect(wrapper.get('[data-testid="worktrees-prune"]').attributes("disabled")).toBeUndefined();
    // The rows have the focus, the first one being the tab stop.
    expect(listed.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("moves with j/k, opens a worktree as the context with Enter and the menu with the menu key", async () => {
    const { wrapper, calls } = await mountDashboard();
    const listed = rows(wrapper);
    // Nothing is selected at first: j selects the first row, then moves down.
    await listed[0]!.trigger("keydown", { key: "j" });
    expect(useWorktreesStore().selectedPath).toBe("/r");
    await listed[0]!.trigger("keydown", { key: "j" });
    expect(useWorktreesStore().selectedPath).toBe("/wt/claude-auth");
    expect(document.activeElement).toBe(listed[1]?.element);
    await listed[1]!.trigger("keydown", { key: "ContextMenu" });
    await nextTick();
    const menu = wrapper.find('[role="menu"]');
    expect(menu.exists()).toBe(true);
    expect(menu.findAll('[role="menuitem"]').map((item) => item.text())).toEqual([
      "Compare with main",
      "Open in terminal",
      "Open in editor",
      "Lock worktree",
      "Remove worktree…",
    ]);
    await menu.get('[data-testid="menu-lock"]').trigger("click");
    await nextTick();
    expect(useWorktreesStore().prompt).toEqual({ kind: "lock", path: "/wt/claude-auth" });
    expect(wrapper.find('[data-testid="worktree-prompt-lock"]').exists()).toBe(true);
    await settled();
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
    await wrapper
      .get('[data-testid="lock-reason"] input, input[data-testid="lock-reason"]')
      .setValue("review");
    await wrapper.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    const lock = calls.find((call) => call.cmd === "worktree_lock");
    expect(lock?.args).toMatchObject({ path: "/wt/claude-auth", reason: "review" });

    await rows(wrapper)[1]!.trigger("keydown", { key: "Enter" });
    await settled();
    expect(calls.filter((call) => call.cmd === "open_repository").at(-1)?.args["path"]).toBe(
      "/wt/claude-auth",
    );
  });

  it("confirms a removal once, then again with force when git refuses a dirty worktree", async () => {
    const { wrapper, calls } = await mountDashboard({ dirtyWorktrees: ["/wt/claude-auth"] });
    const remove = rows(wrapper)[1]!.findAll('[data-testid="worktree-row-actions"] button').at(-1);
    await remove!.trigger("click");
    await nextTick();
    const first = wrapper.get('[data-testid="worktree-prompt-remove"]');
    expect(first.text()).toContain("Remove worktree claude-auth?");
    expect(first.text()).toContain("This deletes the folder /wt/claude-auth.");
    expect(first.text()).toContain("The branch claude/fix-auth stays");
    await first.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    const again = wrapper.get('[data-testid="worktree-prompt-remove"]');
    expect(again.text()).toContain("Remove worktree claude-auth anyway?");
    expect(again.text()).toContain("uncommitted changes, which will be lost");
    expect(again.get('[data-testid="dialog-confirm"]').text()).toBe("Remove anyway");
    await again.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(wrapper.find('[data-testid="worktree-prompt-remove"]').exists()).toBe(false);
    expect(rows(wrapper).map((row) => row.get('[data-testid="worktree-row-path"]').text())).toEqual(
      ["/r", "/wt/gone"],
    );
    expect(
      calls.filter((call) => call.cmd === "worktree_remove").map((c) => c.args["force"]),
    ).toEqual([false, true]);
  });

  it("prunes from the header after one confirmation that lists the missing folders", async () => {
    const { wrapper, calls } = await mountDashboard();
    await wrapper.get('[data-testid="worktrees-prune"]').trigger("click");
    await nextTick();
    const prompt = wrapper.get('[data-testid="worktree-prompt-prune"]');
    expect(prompt.text()).toContain("/wt/gone");
    await prompt.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(calls.some((call) => call.cmd === "worktree_prune")).toBe(true);
    expect(rows(wrapper)).toHaveLength(2);
    expect(wrapper.get('[data-testid="worktrees-prune"]').attributes("disabled")).toBeDefined();
  });

  it("asks for the add dialog from the header", async () => {
    const { wrapper } = await mountDashboard();
    await wrapper.get('[data-testid="worktrees-add"]').trigger("click");
    expect(useWorktreesStore().addOpen).toBe(true);
  });

  it("shows the empty state when the repository has no linked worktree", async () => {
    const { wrapper } = await mountDashboard({ worktrees: fakeWorktrees().slice(0, 1) });
    expect(wrapper.get('[data-testid="worktrees-empty"]').text()).toContain(
      "No worktrees yet. Add one to work on a branch in its own folder while main stays clean.",
    );
    expect(wrapper.get('[data-testid="worktrees-count"]').text()).toBe("0");
    expect(wrapper.find('[data-testid="worktree-table"]').exists()).toBe(false);
    await wrapper.get('[data-testid="worktrees-empty"] button').trigger("click");
    expect(useWorktreesStore().addOpen).toBe(true);
  });

  it("names a missing folder in the banner with Prune worktrees when the editor is asked for it", async () => {
    const { wrapper, calls } = await mountDashboard();
    const editor = rows(wrapper)[2]!.findAll('[data-testid="worktree-row-actions"] button')[1];
    await editor!.trigger("click");
    await nextTick();
    const banner = wrapper.get('[data-testid="worktrees-error"]');
    expect(banner.text()).toContain(
      "Couldn't read /wt/gone. The folder was removed. Prune worktrees to clean this up, or restore the folder if it moved.",
    );
    expect(banner.find("pre").exists()).toBe(false);
    expect(calls.some((call) => call.cmd === "open_external")).toBe(false);
    expect(rows(wrapper)).toHaveLength(3);
    await banner.get("button:last-of-type").trigger("click");
    await nextTick();
    expect(wrapper.find('[data-testid="worktree-prompt-prune"]').exists()).toBe(true);
  });

  it("opens the comparison of main with the worktree from the row action", async () => {
    const { wrapper } = await mountDashboard();
    const compare = rows(wrapper)[1]!.findAll('[data-testid="worktree-row-actions"] button')[0];
    expect(compare?.attributes("aria-label")).toBe("Compare with main");
    await compare!.trigger("click");
    await settled();
    expect(useShellStore().layoutMode).toBe("compare");
    expect(useCompareStore().endpoints?.b).toEqual({
      kind: "worktree",
      rev: "claude/fix-auth",
      label: "claude-auth",
    });
  });
});
