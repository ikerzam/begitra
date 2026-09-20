import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ref as GitRef, Worktree } from "@/ipc/schemas";
import { usePickerStore } from "@/stores/picker";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, fakeCommit, settled } from "@/test/backend";
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
    expect(rows[0]?.choice).toEqual({ kind: "revision", rev: "refs/heads/main" });
    expect(rows[5]?.choice).toEqual({
      kind: "worktree",
      path: "/wt/claude-tiles",
      branch: "claude/migrate",
    });
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
    expect(wrapper.get('[data-testid="picker-empty"]').text()).toContain('Nothing matches "zzz"');
    await input.trigger("keydown", { key: "Escape" });
    expect(picker.mode).toBeNull();
    wrapper.unmount();
  });
});
