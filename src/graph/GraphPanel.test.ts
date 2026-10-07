import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { fakeBackend, fakeCommit } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";
import { chooseOption, optionLabels } from "@/test/select";
import { useBranchesStore } from "@/stores/branches";
import { useGraphStore } from "@/stores/graph";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useShellStore } from "@/stores/shell";
import { useTabsStore } from "@/stores/tabs";
import { useToastsStore } from "@/stores/toasts";
import { shortcutRegistry } from "@/shortcuts/registry";
import type { Ref as GitRef } from "@/ipc/schemas";
import BranchDialogs from "@/branches/BranchDialogs.vue";

import GraphPanel from "./GraphPanel.vue";

async function mountPanel() {
  const wrapper = mountWithI18n(GraphPanel, { attachTo: document.body });
  const container = wrapper.get('[data-testid="commit-rows"]').element;
  Object.defineProperty(container, "clientHeight", { value: 280, configurable: true });
  await wrapper.get('[data-testid="commit-rows"]').trigger("scroll");
  return wrapper;
}

/** Flushes the microtasks of the fake backend and the zero-delay timers (timers are faked). */
async function settled(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  vi.advanceTimersByTime(0);
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function openRepository() {
  const repo = useRepoStore();
  await repo.open("/r");
  await settled();
  return repo;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1_700_000_000 * 1000);
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("GraphPanel filters", () => {
  it("debounces the search 200 ms, restarts the walk and shows the count line", async () => {
    const calls = fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    expect(wrapper.find('[data-testid="filter-count"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="filter-clear"]').exists()).toBe(false);
    const search = wrapper.get('[data-testid="graph-filters"] input');
    await search.setValue("fix(auth)");
    expect(calls.filter((c) => c.cmd === "walk_commits")).toHaveLength(1);
    vi.advanceTimersByTime(199);
    expect(calls.filter((c) => c.cmd === "walk_commits")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await settled();
    expect(calls.filter((c) => c.cmd === "walk_commits")).toHaveLength(2);
    expect(calls.at(-1)?.cmd).not.toBe("count_commits");
    await flushPromises();
    expect(wrapper.get('[data-testid="filter-count"]').text()).toBe("6 of 30 commits");
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(6);
    const clear = wrapper.get('[data-testid="filter-clear"]');
    expect(clear.attributes("aria-label")).toBe("Clear filters");
    expect(clear.find("svg").classes()).toContain("lucide-funnel-x");
    await clear.trigger("click");
    await settled();
    expect((search.element as HTMLInputElement).value).toBe("");
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(20);
    wrapper.unmount();
  });

  it("fills the active controls and lists the authors seen", async () => {
    fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    const author = wrapper.get('[data-testid="filter-author"]');
    expect(await optionLabels(author)).toEqual(["Anyone", "ane", "claude", "iker"]);
    const authorButton = author.get('[data-testid="select-button"]');
    expect(authorButton.attributes("data-active")).toBeUndefined();
    await chooseOption(author, "claude");
    await settled();
    expect(authorButton.attributes("data-active")).toBe("true");
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(10);
    const scope = wrapper.get('[data-testid="filter-scope"]');
    await chooseOption(scope, "current");
    await settled();
    expect(scope.get('[data-testid="select-button"]').attributes("data-active")).toBe("true");
    expect(useGraphStore().walkScope).toEqual({ kind: "ref", name: "main" });
    const date = wrapper.get('[data-testid="filter-date"]');
    expect(await optionLabels(date)).toEqual([
      "Any date",
      "Last 7 days",
      "Last 30 days",
      "Last 3 months",
      "Last year",
    ]);
    wrapper.unmount();
  });

  it("applies a path from the popover and shows the empty state when nothing matches", async () => {
    fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    await wrapper.get('[data-testid="filter-path"]').trigger("click");
    const popover = wrapper.get('[data-testid="path-popover"]');
    await popover.get("input").setValue("apps/api");
    await popover.get("input").trigger("keydown", { key: "Enter" });
    await settled();
    expect(wrapper.find('[data-testid="path-popover"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('[data-testid="filter-path"]').element);
    expect(wrapper.get('[data-testid="filter-path"]').text()).toBe("apps/api");
    expect(useGraphStore().filters.path).toBe("apps/api");
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(15);
    const search = wrapper.get('[data-testid="graph-filters"] input');
    await search.setValue("nothing like this");
    vi.advanceTimersByTime(200);
    await settled();
    await flushPromises();
    const empty = wrapper.get('[data-testid="graph-empty"]');
    expect(empty.text()).toContain("No commits match these filters.");
    expect(wrapper.get('[data-testid="filter-count"]').text()).toBe("0 of 30 commits");
    await empty.get("button").trigger("click");
    await settled();
    expect(wrapper.find('[data-testid="graph-empty"]').exists()).toBe(false);
    expect(useGraphStore().isActive).toBe(false);
    wrapper.unmount();
  });

  it("gives Clear filters the focus when nothing matches and nothing else holds it", async () => {
    fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    const graph = useGraphStore();
    (document.activeElement as HTMLElement | null)?.blur();
    graph.setText("nothing like this");
    await settled();
    await flushPromises();
    const clear = wrapper.get('[data-testid="graph-empty"] button');
    expect(document.activeElement).toBe(clear.element);
    const panel = wrapper.vm as unknown as { focus(): void };
    (document.activeElement as HTMLElement | null)?.blur();
    panel.focus();
    expect(document.activeElement).toBe(clear.element);
    // The search keeps the focus while the user types a query that matches nothing.
    graph.clear();
    await settled();
    await flushPromises();
    const search = wrapper.get('[data-testid="graph-filters"] input').element as HTMLInputElement;
    search.focus();
    graph.setText("nothing like this either");
    await settled();
    await flushPromises();
    expect(wrapper.find('[data-testid="graph-empty"]').exists()).toBe(true);
    expect(document.activeElement).toBe(search);
    wrapper.unmount();
  });
});

describe("GraphPanel hover card and context menu", () => {
  it("shows the hover card after 600 ms on a row and hides it when the pointer leaves", async () => {
    fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    const row = wrapper.findAll('[data-testid="graph-row"]')[7]!;
    await row.trigger("pointerenter");
    vi.advanceTimersByTime(599);
    await nextTick();
    expect(wrapper.find('[data-testid="hover-card"]').exists()).toBe(false);
    vi.advanceTimersByTime(1);
    await nextTick();
    const card = wrapper.get('[data-testid="hover-card"]');
    expect(card.get('[data-testid="hover-subject"]').text()).toBe("commit 7");
    expect(card.get('[data-testid="hover-hash"]').text()).toBe(fakeCommit(7).hash);
    expect(card.text()).toContain("claude@x");
    expect(card.get('[data-testid="hover-compare"]').attributes("disabled")).toBeUndefined();
    // Into the card and back out: it stays, then goes after the grace period.
    await row.trigger("pointerleave");
    await card.trigger("pointerenter");
    vi.advanceTimersByTime(500);
    await nextTick();
    expect(wrapper.find('[data-testid="hover-card"]').exists()).toBe(true);
    await card.trigger("pointerleave");
    vi.advanceTimersByTime(150);
    await nextTick();
    expect(wrapper.find('[data-testid="hover-card"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("Diff from here on the card pins the diff base as a chip", async () => {
    fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    const row = wrapper.findAll('[data-testid="graph-row"]')[2]!;
    await row.trigger("pointerenter");
    vi.advanceTimersByTime(600);
    await nextTick();
    await wrapper.get('[data-testid="hover-diff-from"]').trigger("click");
    await nextTick();
    expect(useReviewStore().diffBase).toBe(fakeCommit(2).hash);
    const chip = wrapper.get('[data-testid="chip-diff-base"]');
    expect(chip.text()).toContain("Diff from 0000000");
    expect(wrapper.find('[data-testid="hover-card"]').exists()).toBe(false);
    await chip.get("button").trigger("click");
    expect(wrapper.find('[data-testid="chip-diff-base"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("opens the context menu on right click, copies the hash and selects the range end", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    const row = wrapper.findAll('[data-testid="graph-row"]')[4]!;
    await row.trigger("contextmenu", { clientX: 300, clientY: 120 });
    const menu = wrapper.get('[role="menu"]');
    expect(menu.attributes("style")).toContain("left: 300px");
    expect(menu.findAll('[role="menuitem"]').map((item) => item.text())).toEqual([
      expect.stringContaining("Copy hash"),
      "Copy message",
      "Diff from here",
      "Compare with…",
      "Select as range end",
      "Create branch here…",
      "Tag…",
      "Cherry-pick",
      "Revert",
      "Reset main to here…",
      "Open in terminal",
      "Open in editor",
    ]);
    expect(wrapper.get('[data-testid="menu-compare"]').attributes("aria-disabled")).toBeUndefined();
    await wrapper.get('[data-testid="menu-copy-hash"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(fakeCommit(4).hash);
    expect(useToastsStore().toasts.at(-1)?.message).toBe("Hash 0000000 copied");
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    await row.trigger("contextmenu", { clientX: 300, clientY: 120 });
    await wrapper.get('[data-testid="menu-range-end"]').trigger("click");
    expect(useReviewStore().rangeEnd).toBe(fakeCommit(4).hash);
    expect(wrapper.get('[data-testid="chip-range-end"]').text()).toContain("Range end 0000000");
    wrapper.unmount();
  });

  it("offers Undo commit on HEAD's row only, and undoes from it", async () => {
    const head = {
      name: "HEAD",
      fullName: "HEAD",
      kind: "head" as const,
      target: fakeCommit(0).hash,
      isCurrent: true,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: fakeCommit(0).committer.time,
    };
    const main = {
      ...head,
      name: "main",
      fullName: "refs/heads/main",
      kind: "local-branch" as const,
    };
    fakeBackend({ refs: [head, main] });
    await openRepository();
    const wrapper = await mountPanel();
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    await rows[1]!.trigger("contextmenu", { clientX: 300, clientY: 120 });
    expect(wrapper.find('[data-testid="menu-undo-commit"]').exists()).toBe(false);
    await rows[0]!.trigger("contextmenu", { clientX: 300, clientY: 120 });
    const undo = wrapper.get('[data-testid="menu-undo-commit"]');
    expect(undo.text()).toBe("Undo commit");
    const spy = vi.spyOn(useBranchesStore(), "undoLastCommit").mockResolvedValue(true);
    await undo.trigger("click");
    // Bound to the row's commit: an undo of another commit is refused.
    expect(spy).toHaveBeenCalledExactlyOnceWith({ expected: fakeCommit(0).hash });
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("closes the commit menu before its item acts, so the dialog it opens keeps the focus", async () => {
    // A browser renders between the item's click listener and the menu's own: the item's
    // listener alone, then a render, is what the dialog meets. The rows have the focus back by
    // then, so the dialog takes it and gives it back to them.
    fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    const dialogs = mountWithI18n(BranchDialogs, { attachTo: document.body });
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    await rows[1]!.trigger("contextmenu", { clientX: 300, clientY: 120 });
    wrapper
      .get('[data-testid="menu-create-branch"]')
      .element.dispatchEvent(new MouseEvent("click", { bubbles: false }));
    await settled();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.contains(document.activeElement)).toBe(true);
    dialog!.querySelector<HTMLElement>('[data-testid="dialog-cancel"]')!.click();
    await settled();
    expect(
      wrapper.get('[data-testid="commit-rows"]').element.contains(document.activeElement),
    ).toBe(true);
    dialogs.unmount();
    wrapper.unmount();
  });

  it("keeps the menu on its commit, and closes it once the history no longer lists it", async () => {
    fakeBackend();
    const repo = await openRepository();
    const wrapper = await mountPanel();
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    await rows[1]!.trigger("contextmenu", { clientX: 300, clientY: 120 });
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    // A commit lands above: the menu's commit moves down a row and the menu stays on it.
    repo.commits = [fakeCommit(99), ...repo.commits];
    await nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    // The history listed again without it: the menu goes.
    repo.commits = repo.commits.filter((commit) => commit.hash !== fakeCommit(1).hash);
    await nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("opens the branch menu from a ref badge instead of the commit's", async () => {
    fakeBackend();
    const repo = await openRepository();
    const wrapper = await mountPanel();
    const badge = wrapper.get('[data-testid="graph-row"] [data-ref="refs/heads/main"]');
    expect(badge.text()).toBe("main");
    await badge.trigger("contextmenu", { clientX: 200, clientY: 80 });
    const menu = wrapper.get('[role="menu"]');
    expect(menu.attributes("aria-label")).toBe("Branch actions");
    expect(menu.attributes("style")).toContain("left: 200px");
    expect(wrapper.find('[data-testid="menu-copy-hash"]').exists()).toBe(false);
    expect(repo.selectedIndex).toBe(0);
    // The current branch: no checkout, merge, rebase or delete; the dialogs are open.
    expect(wrapper.get('[data-testid="menu-checkout"]').attributes("aria-disabled")).toBe("true");
    await wrapper.get('[data-testid="menu-rename"]').trigger("click");
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(useBranchesStore().prompt).toEqual({ kind: "rename", name: "main" });
    wrapper.unmount();
  });

  it("copies the hash of the focused row with Ctrl C and opens the menu from the keyboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    fakeBackend();
    const repo = await openRepository();
    const wrapper = await mountPanel();
    repo.select(3);
    await nextTick();
    const list = wrapper.get('[data-testid="commit-rows"]');
    await list.trigger("keydown", { key: "c", ctrlKey: true });
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(fakeCommit(3).hash);
    await list.trigger("keydown", { key: "ContextMenu" });
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    await list.trigger("keydown", { key: "Escape" });
    wrapper.unmount();
  });
});

describe("GraphPanel broken history", () => {
  it("keeps the rows, shows the banner where the next rows would be and offers the terminal", async () => {
    const calls = fakeBackend({ commits: 1_200, pageSize: 500, failAfterPages: 2 });
    const repo = await openRepository();
    const wrapper = await mountPanel();
    expect(repo.commits).toHaveLength(1_000);
    expect(repo.walkError?.code).toBe("repo.corrupt_object");
    const banner = wrapper.get('[data-testid="graph-walk-error"]');
    expect(banner.text()).toContain("Couldn't read history past 0000000.");
    expect(banner.text()).toContain("object file .git/objects/6c/1f0ab is empty");
    expect(wrapper.findAll('[data-testid="skeleton-row"]')).toHaveLength(0);
    expect(repo.canLoadMore).toBe(false);
    await banner.get("button").trigger("click");
    await flushPromises();
    expect(calls.some((c) => c.cmd === "open_external")).toBe(true);
    wrapper.unmount();
  });
});

describe("GraphPanel working tree row", () => {
  it("shows the working tree's row above the commits and opens the changes screen from it", async () => {
    fakeBackend({
      changes: { unstaged: [changedFile("a.ts")], staged: [changedFile("b.ts")] },
    });
    await openRepository();
    const wrapper = await mountPanel();
    await settled();
    const row = wrapper.get('[data-testid="working-tree-row"]');
    expect(
      wrapper
        .get('[data-testid="working-tree-counts"]')
        .findAll("span")
        .map((part) => part.text()),
    ).toEqual(["1 unstaged", "1 staged"]);
    // Above the list, not in it: the rows and the selection are the commits'.
    const position = row.element.compareDocumentPosition(
      wrapper.get('[data-testid="commit-rows"]').element,
    );
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(useRepoStore().selectedIndex).toBe(0);
    await row.trigger("click");
    expect(useShellStore().layoutMode).toBe("changes");
    wrapper.unmount();
  });
});

describe("GraphPanel quick wins", () => {
  const ref = (name: string, kind: GitRef["kind"], fullName: string, target: string): GitRef => ({
    name,
    fullName,
    kind,
    target,
    isCurrent: kind === "head" || name === "main",
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
    committedAt: null,
  });
  const refs = () => [
    ref("main", "local-branch", "refs/heads/main", fakeCommit(0).hash),
    ref("develop", "local-branch", "refs/heads/develop", fakeCommit(3).hash),
    ref(
      "origin/claude/tiles",
      "remote-branch",
      "refs/remotes/origin/claude/tiles",
      fakeCommit(2).hash,
    ),
    ref("HEAD", "head", "HEAD", fakeCommit(0).hash),
  ];

  it("hides the remote branches from its toggle and walks a pattern's branches from its popover", async () => {
    const calls = fakeBackend({ refs: refs() });
    await openRepository();
    const wrapper = await mountPanel();
    const walks = () => calls.filter((c) => c.cmd === "walk_commits");
    const toggle = wrapper.get('[data-testid="filter-remotes"]');
    expect(toggle.attributes("aria-pressed")).toBe("false");
    await toggle.trigger("click");
    await settled();
    expect(toggle.attributes("aria-pressed")).toBe("true");
    expect(walks().at(-1)?.args["scope"]).toEqual({ kind: "local" });
    const scope = wrapper.get('[data-testid="filter-scope"]');
    await chooseOption(scope, "pattern-edit");
    const popover = wrapper.get('[data-testid="pattern-popover"]');
    await popover.get("input").setValue("*/tiles");
    expect(popover.get('[data-testid="pattern-matched"]').text()).toBe(
      "1 branch: 0 local, 1 remote",
    );
    await popover.get("input").setValue("dev*");
    expect(popover.get('[data-testid="pattern-matched"]').text()).toBe(
      "1 branch: 1 local, 0 remote",
    );
    await popover.get('[data-testid="pattern-apply"]').trigger("click");
    await settled();
    expect(walks().at(-1)?.args["scope"]).toEqual({ kind: "refs", names: ["refs/heads/develop"] });
    expect(scope.text()).toContain("dev*");
    expect(scope.text()).toContain("1");
    // A pattern that matches nothing says so.
    await chooseOption(scope, "pattern-edit");
    // It opens on the pattern the scope holds.
    expect(
      (wrapper.get('[data-testid="pattern-popover"] input').element as HTMLInputElement).value,
    ).toBe("dev*");
    await wrapper.get('[data-testid="pattern-popover"] input').setValue("codex/*");
    await wrapper.get('[data-testid="pattern-apply"]').trigger("click");
    await settled();
    expect(wrapper.text()).toContain("No branch matches “codex/*”.");
    wrapper.unmount();
  });

  it("says when a pattern matches more branches than the graph walks", async () => {
    const many = Array.from({ length: 2_001 }, (_, i) =>
      ref(`claude/b${i}`, "local-branch", `refs/heads/claude/b${i}`, fakeCommit(1).hash),
    );
    const calls = fakeBackend({ refs: [...refs(), ...many] });
    await openRepository();
    const wrapper = await mountPanel();
    const scope = wrapper.get('[data-testid="filter-scope"]');
    await chooseOption(scope, "pattern-edit");
    const popover = wrapper.get('[data-testid="pattern-popover"]');
    await popover.get("input").setValue("claude/*");
    expect(popover.get('[data-testid="pattern-matched"]').text()).toBe(
      "2,002 branches: 2,001 local, 1 remote. The graph walks the first 2,000.",
    );
    await popover.get('[data-testid="pattern-apply"]').trigger("click");
    await settled();
    const walk = calls.filter((c) => c.cmd === "walk_commits").at(-1);
    expect((walk?.args["scope"] as { names: string[] }).names).toHaveLength(2_000);
    expect(scope.text()).toContain("2,000 of 2,002");
    wrapper.unmount();
  });

  it("goes to HEAD from its button and from h, and says when the scope leaves it out", async () => {
    fakeBackend({ refs: refs() });
    const repo = await openRepository();
    const wrapper = await mountPanel();
    repo.select(4);
    await wrapper.get('[data-testid="filter-go-to-head"]').trigger("click");
    await settled();
    expect(repo.selectedIndex).toBe(0);
    repo.select(5);
    // `h` from outside the rows is not theirs.
    (document.activeElement as HTMLElement | null)?.blur();
    shortcutRegistry().dispatch(new KeyboardEvent("keydown", { key: "h", cancelable: true }));
    await settled();
    expect(repo.selectedIndex).toBe(5);
    wrapper.get<HTMLElement>('[data-testid="graph-row"][data-index="5"]').element.focus();
    shortcutRegistry().dispatch(new KeyboardEvent("keydown", { key: "h", cancelable: true }));
    await settled();
    expect(repo.selectedIndex).toBe(0);
    expect(document.activeElement?.getAttribute("data-index")).toBe("0");
    // A pattern whose branches do not reach HEAD's commit.
    useGraphStore().setScope({ kind: "pattern", pattern: "nothing/*" });
    await settled();
    await wrapper.get('[data-testid="filter-go-to-head"]').trigger("click");
    await settled();
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.message).toBe("HEAD is not in this scope.");
    expect(toast?.action).toBe("Show all");
    toast?.onAction?.();
    await settled();
    expect(useGraphStore().filters.scope).toEqual({ kind: "all" });
    expect(repo.selectedIndex).toBe(0);
    wrapper.unmount();
  });

  it("compares the selected commit with a Ctrl-clicked one in its own tab", async () => {
    fakeBackend({ refs: refs() });
    const repo = await openRepository();
    const wrapper = await mountPanel();
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    await rows[2]!.trigger("click", { ctrlKey: true });
    await settled();
    expect(repo.selectedIndex).toBe(0);
    expect(useTabsStore().activePair).toEqual({
      a: { kind: "revision", rev: fakeCommit(0).hash, label: fakeCommit(0).hash.slice(0, 7) },
      b: { kind: "revision", rev: fakeCommit(2).hash, label: fakeCommit(2).hash.slice(0, 7) },
    });
    wrapper.unmount();
  });
});
