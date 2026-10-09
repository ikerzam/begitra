import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ref as GitRef, Worktree } from "@/ipc/schemas";
import { usePickerStore } from "@/stores/picker";
import { useRecentBranchesStore } from "@/stores/recentBranches";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, fakeCommit, settled, writeGate } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import PickerOverlay from "./PickerOverlay.vue";
import { parseRange, pickerRows, toggleDots } from "./usePicker";

function ref(overrides: Partial<GitRef> & Pick<GitRef, "name" | "fullName" | "kind">): GitRef {
  return {
    target: fakeCommit(0).hash,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
    committedAt: null,
    ...overrides,
  };
}

const refs: GitRef[] = [
  ref({
    name: "main",
    fullName: "refs/heads/main",
    kind: "local-branch",
    isCurrent: true,
    upstream: "origin/main",
    ahead: 2,
    behind: 0,
  }),
  ref({
    name: "develop",
    fullName: "refs/heads/develop",
    kind: "local-branch",
    upstream: "origin/develop",
    ahead: 0,
    behind: 3,
  }),
  ref({
    name: "claude/fix-auth",
    fullName: "refs/heads/claude/fix-auth",
    kind: "local-branch",
    worktree: "/wt/claude-auth",
  }),
  ref({ name: "origin/main", fullName: "refs/remotes/origin/main", kind: "remote-branch" }),
  ref({ name: "v2.3.1", fullName: "refs/tags/v2.3.1", kind: "tag", target: fakeCommit(3).hash }),
];

const worktrees: Worktree[] = [
  {
    path: "/r",
    name: null,
    head: null,
    branch: "main",
    detached: false,
    isMain: true,
    locked: false,
    lockReason: null,
    prunable: false,
    bare: false,
  },
  {
    path: "/wt/claude-tiles",
    name: "claude-tiles",
    head: null,
    branch: "claude/migrate",
    detached: false,
    isMain: false,
    locked: false,
    lockReason: null,
    prunable: false,
    bare: false,
  },
];

const inputs = {
  refs,
  worktrees,
  commits: [fakeCommit(0), fakeCommit(1)],
  lanes: new Map([
    ["refs/heads/main", 1],
    ["refs/heads/develop", 2],
  ]),
  ago: () => "3h ago",
  words: { current: "current", worktree: "worktree" },
};

describe("parseRange and toggleDots", () => {
  it("recognises two-dot and three-dot ranges only", () => {
    expect(parseRange("v2.3.1..main")).toEqual({ from: "v2.3.1", to: "main", threeDot: false });
    expect(parseRange(" a...b ")).toEqual({ from: "a", to: "b", threeDot: true });
    expect(parseRange("main")).toBeNull();
    expect(parseRange("..main")).toBeNull();
    expect(parseRange("a....b")).toBeNull();
    expect(toggleDots("v2.3.1..main")).toBe("v2.3.1...main");
    expect(toggleDots("v2.3.1...main")).toBe("v2.3.1..main");
    expect(toggleDots("main")).toBe("main");
  });
});

describe("pickerRows", () => {
  it("groups branches, tags, worktrees and recent commits with their context", () => {
    const rows = pickerRows({ ...inputs, query: "" });
    expect(rows.map((row) => [row.section, row.label, row.context])).toEqual([
      ["branches", "main", "current ↑2 ↓0"],
      ["branches", "develop", "↑0 ↓3"],
      ["branches", "claude/fix-auth", "worktree /wt/claude-auth"],
      ["branches", "origin/main", ""],
      ["tags", "v2.3.1", "0000000"],
      ["worktrees", "/wt/claude-tiles", "claude/migrate"],
      ["commits", "0000000  fix(auth): commit 0", "3h ago"],
      ["commits", "0000000  commit 1", "3h ago"],
    ]);
    expect(rows[0]?.lane).toBe(1);
    expect(rows[0]?.choice).toEqual({ kind: "revision", rev: "refs/heads/main", label: "main" });
    expect(rows[5]?.choice).toEqual({
      kind: "worktree",
      path: "/wt/claude-tiles",
      branch: "claude/migrate",
    });
  });

  it("lists the recent branches first, in their order, and leaves them out of Branches", () => {
    const recent = ["claude/fix-auth", "gone/branch", "main", "develop"];
    const rows = pickerRows({ ...inputs, query: "", recent });
    expect(rows.slice(0, 4).map((row) => [row.section, row.label, row.context])).toEqual([
      // A name the listing no longer has, and the current branch, are left out.
      ["recent", "claude/fix-auth", "worktree /wt/claude-auth"],
      ["recent", "develop", "↑0 ↓3"],
      ["branches", "main", "current ↑2 ↓0"],
      ["branches", "origin/main", ""],
    ]);
    expect(rows[1]?.lane).toBe(2);
    expect(rows[1]?.choice).toEqual({
      kind: "revision",
      rev: "refs/heads/develop",
      label: "develop",
    });
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    // The query filters both groups.
    const typed = pickerRows({ ...inputs, query: "dev", recent });
    expect(typed.map((row) => [row.section, row.label])).toEqual([["recent", "develop"]]);
    // Without recent names the groups are as before.
    expect(pickerRows({ ...inputs, query: "", recent: [] })[0]?.section).toBe("branches");
  });

  it("filters by the query and shows the range group for a typed range", () => {
    expect(pickerRows({ ...inputs, query: "v2" }).map((row) => row.label)).toEqual(["v2.3.1"]);
    expect(pickerRows({ ...inputs, query: "nothing" })).toEqual([]);
    const rows = pickerRows({ ...inputs, query: "v2.3.1..main" });
    expect(rows.map((row) => [row.section, row.label])).toEqual([
      ["range", "v2.3.1..main"],
      ["endpoints", "v2.3.1"],
      ["endpoints", "main"],
    ]);
    expect(rows[0]?.choice).toEqual({ kind: "range", from: "v2.3.1", to: "main", threeDot: false });
    expect(rows[2]?.lane).toBe(1);
  });
});

describe("PickerOverlay", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    clearMocks();
    document.body.innerHTML = "";
  });

  it("chooses with the keyboard, switches the dots with Tab and opens review on the target", async () => {
    fakeBackend();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const picker = usePickerStore();
    const review = useReviewStore();
    const shell = useShellStore();
    picker.open({ kind: "diff-from" });
    const wrapper = mountWithI18n(PickerOverlay, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="picker-title"]').text()).toBe("Diff from…");
    const input = wrapper.get('[data-testid="picker-input"]');
    expect(document.activeElement).toBe(input.element);
    expect(wrapper.findAll('[data-testid="picker-row"]').map((r) => r.text())).toEqual([
      "maincurrent",
      "develop",
      ...wrapper
        .findAll('[data-testid="picker-row"]')
        .slice(2)
        .map((r) => r.text()),
    ]);
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(picker.mode).toBeNull();
    expect(review.chosenTarget).toEqual({
      kind: "range",
      from: "refs/heads/develop",
      to: "HEAD",
      threeDot: false,
    });
    expect(shell.layoutMode).toBe("review");
    wrapper.unmount();
    // A typed range: Tab switches the dots, Enter chooses the range row.
    picker.open({ kind: "diff-from" });
    const again = mountWithI18n(PickerOverlay, { attachTo: document.body });
    await flushPromises();
    const field = again.get('[data-testid="picker-input"]');
    await field.setValue("develop..main");
    expect(again.get('[data-testid="picker-chips"]').text()).toContain("A..B lists what B has");
    await field.trigger("keydown", { key: "Tab" });
    expect((field.element as HTMLInputElement).value).toBe("develop...main");
    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(review.chosenTarget).toEqual({
      kind: "range",
      from: "develop",
      to: "main",
      threeDot: true,
    });
    again.unmount();
  });

  it("lists the branches HEAD left most recently first when it checks out, not otherwise", async () => {
    const calls = fakeBackend({ recentBranches: ["develop"] });
    // Made with the shell, as the app does.
    useRecentBranchesStore();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const picker = usePickerStore();
    picker.open({ kind: "branch-action", action: "checkout" });
    const wrapper = mountWithI18n(PickerOverlay, { attachTo: document.body });
    await flushPromises();
    await settled();
    expect(wrapper.get('[data-testid="picker-title"]').text()).toBe("Checkout");
    const sections = (w: typeof wrapper) => w.findAll(".picker-section").map((p) => p.text());
    expect(sections(wrapper).slice(0, 2)).toEqual(["Recent branches", "Branches"]);
    const rows = wrapper.findAll('[data-testid="picker-row"]').map((r) => r.text());
    expect(rows[0]).toBe("develop");
    expect(rows.filter((text) => text.startsWith("develop"))).toHaveLength(1);
    // The listbox is named by the title, and each group by its label.
    const named = (id: string | undefined) => (id ? document.getElementById(id)?.textContent : "");
    const list = wrapper.get('[role="listbox"]');
    expect(named(list.attributes("aria-labelledby"))?.trim()).toBe("Checkout");
    const groups = wrapper.findAll('[role="group"]');
    expect(groups.map((group) => named(group.attributes("aria-labelledby"))?.trim())).toEqual(
      sections(wrapper),
    );
    expect(groups[0]?.findAll('[role="option"]').map((option) => option.text())).toEqual([
      "develop",
    ]);
    // The arrows cross from Recent branches into Branches and back; Enter checks out the row.
    const input = wrapper.get('[data-testid="picker-input"]');
    const active = () => {
      const id = input.attributes("aria-activedescendant");
      return id ? document.getElementById(id)?.textContent?.trim() : undefined;
    };
    expect(active()).toBe("develop");
    await input.trigger("keydown", { key: "ArrowDown" });
    expect(active()).toMatch(/^main/);
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(active()).toBe("develop");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    await settled();
    expect(
      calls.filter((call) => call.cmd === "switch").map((call) => call.args["target"]),
    ).toEqual([{ kind: "branch", name: "develop" }]);
    wrapper.unmount();
    // The other pickers keep their groups.
    const main = { kind: "revision" as const, rev: "refs/heads/main", label: "main" };
    for (const mode of [
      { kind: "diff-from" as const },
      { kind: "branch-action" as const, action: "merge" as const },
      { kind: "branch-action" as const, action: "rebase" as const },
      { kind: "branch-action" as const, action: "create" as const },
      { kind: "compare" as const, side: "b" as const, other: main },
    ]) {
      picker.open(mode);
      const other = mountWithI18n(PickerOverlay, { attachTo: document.body });
      await flushPromises();
      expect(sections(other)).toContain("Branches");
      expect(sections(other)).not.toContain("Recent branches");
      other.unmount();
    }
  });

  /** The checkout picker over `/r`, opened before the first read of the recent branches answers. */
  async function checkoutBeforeTheRead() {
    const gate = writeGate();
    fakeBackend({ recentBranches: ["develop"], recentGate: gate });
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    usePickerStore().open({ kind: "branch-action", action: "checkout" });
    const wrapper = mountWithI18n(PickerOverlay, { attachTo: document.body });
    await flushPromises();
    const input = wrapper.get('[data-testid="picker-input"]');
    const active = () => {
      const id = input.attributes("aria-activedescendant");
      return id ? document.getElementById(id)?.textContent?.trim() : undefined;
    };
    const first = () => wrapper.findAll(".picker-section").map((p) => p.text())[0];
    // Branches alone until the read answers, the cursor on the first row.
    expect(first()).toBe("Branches");
    expect(active()).toMatch(/^main/);
    expect(gate.waiting).toEqual(["recent_branches"]);
    const land = async () => {
      gate.release();
      await flushPromises();
      await settled();
      expect(first()).toBe("Recent branches");
    };
    return { wrapper, input, active, land };
  }

  it("puts a cursor the user did not move on the first row when the recent branches land", async () => {
    const { wrapper, active, land } = await checkoutBeforeTheRead();
    await land();
    expect(active()).toBe("develop");
    wrapper.unmount();
  });

  it("keeps a cursor the user moved on its row when the recent branches land", async () => {
    const { wrapper, input, active, land } = await checkoutBeforeTheRead();
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(active()).toMatch(/^main/);
    await land();
    expect(active()).toMatch(/^main/);
    // Typing goes back to the first row.
    await input.setValue("e");
    await flushPromises();
    expect(active()).toBe("develop");
    wrapper.unmount();
  });

  it("shows the empty sentence and closes with Escape", async () => {
    fakeBackend();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const picker = usePickerStore();
    picker.open({ kind: "diff-from" });
    const wrapper = mountWithI18n(PickerOverlay, { attachTo: document.body });
    await flushPromises();
    const input = wrapper.get('[data-testid="picker-input"]');
    await input.setValue("zzz");
    expect(wrapper.get('[data-testid="picker-empty"]').text()).toContain('No refs match "zzz"');
    await input.trigger("keydown", { key: "Escape" });
    expect(picker.mode).toBeNull();
    wrapper.unmount();
  });

  it("dims the window and closes on a press on it, not on a selection released there", async () => {
    fakeBackend();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const picker = usePickerStore();
    picker.open({ kind: "diff-from" });
    const wrapper = mountWithI18n(PickerOverlay, { attachTo: document.body });
    await flushPromises();
    const scrim = wrapper.get('[data-testid="picker-overlay"]');
    expect(scrim.classes()).toEqual(expect.arrayContaining(["fixed", "inset-0", "bg-shadow"]));
    await wrapper.get('[data-testid="picker-input"]').trigger("pointerdown");
    await scrim.trigger("click");
    expect(picker.mode).not.toBeNull();
    await scrim.trigger("pointerdown");
    expect(picker.mode).toBeNull();
    wrapper.unmount();
  });

  it("closes on Esc from its close button, where the query's keys do not reach", async () => {
    fakeBackend();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const picker = usePickerStore();
    picker.open({ kind: "diff-from" });
    const wrapper = mountWithI18n(PickerOverlay, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[role="dialog"]').attributes("tabindex")).toBe("-1");
    const close = wrapper.get('[role="dialog"] button');
    await close.trigger("keydown", { key: "Escape" });
    expect(picker.mode).toBeNull();
    wrapper.unmount();
  });
});
