import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import WorktreeRow from "./WorktreeRow.vue";

const worktree = {
  path: "/wt/claude-auth",
  branch: "claude/fix-auth",
  lane: 4,
  dirty: true,
  ahead: 5,
  behind: 1,
  lastCommit: "fix(api): refresh tokens before expiry",
  lastCommitDate: "3h ago",
};

function actionLabels(wrapper: ReturnType<typeof mountWithI18n>) {
  return wrapper
    .findAll("[data-testid='worktree-row-actions'] button")
    .map((b) => b.attributes("aria-label"));
}

describe("WorktreeRow", () => {
  it("shows path in mono, branch with lane dot and dirty marker, counts, commit and actions", () => {
    const wrapper = mountWithI18n(WorktreeRow, { props: worktree });
    expect(wrapper.attributes("role")).toBe("option");
    expect(wrapper.classes()).toContain("h-row-list");
    const path = wrapper.get("[data-testid='worktree-row-path']");
    expect(path.text()).toBe("/wt/claude-auth");
    expect(path.classes()).toContain("font-mono");
    expect(path.classes()).toContain("text-fg-muted");
    const branch = wrapper.get("[data-testid='worktree-row-branch']");
    expect(branch.get("[data-lane]").classes()).toContain("bg-lane-4");
    expect(branch.text()).toBe("claude/fix-auth");
    expect(branch.find("[title='Uncommitted changes']").exists()).toBe(true);
    expect(wrapper.get("[data-testid='worktree-row-state']").text()).toBe("");
    expect(wrapper.get("[data-testid='ahead']").text()).toBe("5");
    expect(wrapper.get("[data-testid='behind']").text()).toBe("1");
    expect(wrapper.get("[data-testid='worktree-row-commit']").text()).toContain(
      "fix(api): refresh tokens before expiry",
    );
    expect(wrapper.get("[data-testid='worktree-row-commit']").text()).toContain("3h ago");
    expect(actionLabels(wrapper)).toEqual([
      "Diff vs main",
      "Open in terminal",
      "Open in editor",
      "Remove worktree",
    ]);
  });

  it("emits one event per action without selecting the row", async () => {
    const wrapper = mountWithI18n(WorktreeRow, { props: worktree });
    const buttons = wrapper.findAll("[data-testid='worktree-row-actions'] button");
    for (const button of buttons) await button.trigger("click");
    expect(wrapper.emitted("diff")).toHaveLength(1);
    expect(wrapper.emitted("terminal")).toHaveLength(1);
    expect(wrapper.emitted("editor")).toHaveLength(1);
    expect(wrapper.emitted("remove")).toHaveLength(1);
    expect(wrapper.emitted("select")).toBeUndefined();
    await wrapper.trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
  });

  it("lists the main worktree without diff and remove actions", () => {
    const wrapper = mountWithI18n(WorktreeRow, {
      props: { path: "~/code/geoportal", branch: "main", lane: 1, main: true },
    });
    expect(wrapper.get("[data-testid='worktree-row-state']").text()).toBe("main worktree");
    expect(actionLabels(wrapper)).toEqual(["Open in terminal", "Open in editor"]);
  });

  it("shows the locked state with a lock icon", () => {
    const wrapper = mountWithI18n(WorktreeRow, {
      props: { path: "/wt/review-2.4", branch: "release/2.4", lane: 5, locked: true },
    });
    const state = wrapper.get("[data-testid='worktree-row-state']");
    expect(state.text()).toBe("Locked");
    expect(state.classes()).toContain("text-fg-secondary");
    expect(state.get("svg").classes()).toContain("lucide-lock");
  });

  it("flags a missing folder in --warn and tells the user to prune", () => {
    const wrapper = mountWithI18n(WorktreeRow, {
      props: { path: "/wt/old-spike", branch: "spike/wasm-tiles", lane: 8, missing: true },
    });
    const state = wrapper.get("[data-testid='worktree-row-state']");
    expect(state.text()).toBe("Folder missing");
    expect(state.classes()).toContain("text-warn");
    expect(state.get("svg").classes()).toContain("lucide-circle-alert");
    expect(wrapper.get("[data-testid='worktree-row-path']").classes()).toContain(
      "text-fg-disabled",
    );
    expect(wrapper.find("[data-testid='ahead']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='worktree-row-commit']").text()).toBe(
      "Prune to remove this entry",
    );
  });

  it("translates states and action names", () => {
    const wrapper = mountWithI18n(
      WorktreeRow,
      { props: { ...worktree, locked: true } },
      { locale: "es" },
    );
    expect(wrapper.get("[data-testid='worktree-row-state']").text()).toBe("Bloqueado");
    expect(actionLabels(wrapper)).toEqual([
      "Diff con main",
      "Abrir en la terminal",
      "Abrir en el editor",
      "Eliminar worktree",
    ]);
  });
});
