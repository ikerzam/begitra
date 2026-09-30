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
    expect(wrapper.attributes("role")).toBe("row");
    expect(wrapper.findAll("[role='gridcell']")).toHaveLength(6);
    expect(wrapper.classes()).toContain("h-row-list");
    const path = wrapper.get("[data-testid='worktree-row-path']");
    expect(path.text()).toBe("/wt/claude-auth");
    expect(path.classes()).toContain("font-mono");
    expect(path.classes()).toContain("text-fg-muted");
    const branch = wrapper.get("[data-testid='worktree-row-branch']");
    expect(branch.get("[data-lane]").classes()).toContain("bg-lane-4");
    expect(branch.text()).toBe("claude/fix-auth");
    expect(branch.find("[data-tooltip='Uncommitted changes']").exists()).toBe(true);
    expect(wrapper.get("[data-testid='worktree-row-state']").text()).toBe("");
    expect(wrapper.get("[data-testid='ahead']").text()).toBe("5");
    expect(wrapper.get("[data-testid='behind']").text()).toBe("1");
    expect(wrapper.get("[data-testid='worktree-row-commit']").text()).toContain(
      "fix(api): refresh tokens before expiry",
    );
    expect(wrapper.get("[data-testid='worktree-row-commit']").text()).toContain("3h ago");
    expect(actionLabels(wrapper)).toEqual([
      "Compare with main",
      "Open in terminal",
      "Open in editor",
      "Remove worktree",
    ]);
  });

  it("shows no counts until they are known and the lock reason as the state's tooltip", () => {
    const wrapper = mountWithI18n(WorktreeRow, {
      props: { ...worktree, ahead: null, behind: null, locked: true, lockReason: "review" },
    });
    expect(wrapper.find("[data-testid='ahead']").exists()).toBe(false);
    const state = wrapper.get("[data-testid='worktree-row-state']");
    expect(state.attributes("data-tooltip")).toBe("review");
    expect(state.attributes("aria-description")).toBe("review");
  });

  it("asks for the context menu from a right click and from the menu key", async () => {
    const wrapper = mountWithI18n(WorktreeRow, { props: worktree });
    await wrapper.trigger("contextmenu", { clientX: 40, clientY: 50 });
    expect(wrapper.emitted("menu")?.[0]).toEqual([40, 50]);
    expect(wrapper.emitted("select")).toHaveLength(1);
    await wrapper.trigger("keydown", { key: "ContextMenu" });
    expect(wrapper.emitted("menu")).toHaveLength(2);
    await wrapper.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")).toHaveLength(1);
    // Enter on one of the row's buttons is the button's, not the row's.
    const button = wrapper.get("[data-testid='worktree-row-actions'] button");
    await button.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")).toHaveLength(1);
    expect(button.attributes("tabindex")).toBe("-1");
  });

  it("emits one event per action without selecting the row", async () => {
    const wrapper = mountWithI18n(WorktreeRow, { props: worktree });
    const buttons = wrapper.findAll("[data-testid='worktree-row-actions'] button");
    for (const button of buttons) await button.trigger("click");
    expect(wrapper.emitted("compare")).toHaveLength(1);
    expect(wrapper.emitted("terminal")).toHaveLength(1);
    expect(wrapper.emitted("editor")).toHaveLength(1);
    expect(wrapper.emitted("remove")).toHaveLength(1);
    expect(wrapper.emitted("select")).toBeUndefined();
    await wrapper.trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
  });

  it("shows its removal running: busy, a sweeping bar in its state and no remove action", () => {
    const wrapper = mountWithI18n(WorktreeRow, { props: { ...worktree, removing: true } });
    expect(wrapper.attributes("aria-busy")).toBe("true");
    const state = wrapper.get("[data-testid='worktree-row-state']");
    expect(state.text()).toBe("Removing");
    expect(state.find("[data-testid='worktree-row-removing']").exists()).toBe(true);
    const remove = wrapper
      .findAll("button")
      .find((button) => button.attributes("aria-label") === "Remove worktree");
    expect(remove?.attributes("disabled")).toBeDefined();
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
    expect(state.classes()).toContain("text-fg-muted");
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
      "Comparar con main",
      "Abrir en la terminal",
      "Abrir en el editor",
      "Eliminar worktree",
    ]);
  });
});
