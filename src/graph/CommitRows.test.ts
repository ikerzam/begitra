import { describe, expect, it } from "vitest";

import type { CommitNode, Ref as GitRef } from "@/ipc/schemas";
import { mountWithI18n } from "@/test/mount";

import CommitRows from "./CommitRows.vue";

function commit(n: number, refs: string[] = []): CommitNode {
  const who = {
    name: "iker",
    email: "i@x",
    time: Math.floor(Date.now() / 1000) - n * 3600,
    offsetMinutes: 0,
  };
  return {
    hash: n.toString(16).padEnd(40, "0"),
    parents: [],
    author: who,
    committer: who,
    subject: `commit ${n}`,
    body: "",
    refs,
    lane: 0,
    edges: [],
    overflow: 0,
  };
}

const refs: GitRef[] = [
  {
    name: "main",
    fullName: "refs/heads/main",
    kind: "local-branch",
    target: commit(0).hash,
    isCurrent: true,
    upstream: "origin/main",
    ahead: 2,
    behind: 0,
    worktree: "/r",
    message: null,
  },
  {
    name: "origin/main",
    fullName: "refs/remotes/origin/main",
    kind: "remote-branch",
    target: commit(0).hash,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
  },
  {
    name: "v1",
    fullName: "refs/tags/v1",
    kind: "tag",
    target: commit(3).hash,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
  },
];

function mountRows(count = 30, extra: Record<string, unknown> = {}) {
  const commits = Array.from({ length: count }, (_, i) =>
    commit(i, i === 0 ? ["HEAD", "main", "origin/main"] : i === 3 ? ["v1"] : []),
  );
  return mountWithI18n(CommitRows, {
    props: { commits, refs, selectedIndex: 0, ...extra },
    attachTo: document.body,
  });
}

describe("CommitRows", () => {
  it("renders one row per commit with badges, hash and relative date", () => {
    const wrapper = mountRows(5);
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    expect(rows).toHaveLength(5);
    expect(rows[0]?.text()).toContain("commit 0");
    expect(rows[0]?.text()).toContain("main");
    expect(rows[0]?.text()).toContain("origin/main");
    expect(rows[0]?.text()).not.toContain("HEAD");
    expect(rows[3]?.text()).toContain("v1");
    expect(rows[1]?.find('[data-testid="graph-row-hash"]').text()).toBe("1000000");
    expect(rows[1]?.find('[data-testid="graph-row-date"]').text()).toBe("1h ago");
    wrapper.unmount();
  });

  it("moves the selection with j and k and emits select", async () => {
    const wrapper = mountRows(10);
    const list = wrapper.get('[data-testid="commit-rows"]');
    for (let i = 0; i < 3; i += 1) await list.trigger("keydown", { key: "j" });
    expect(wrapper.emitted("select")?.map((e) => e[0])).toEqual([1, 1, 1]);
    await wrapper.setProps({ selectedIndex: 3 });
    await list.trigger("keydown", { key: "k" });
    expect(wrapper.emitted("select")?.at(-1)).toEqual([2]);
    await list.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")?.at(-1)).toEqual([3]);
    wrapper.unmount();
  });

  it("keeps the tab stop on the selected row and moves focus with the selection", async () => {
    const wrapper = mountRows(5);
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    expect(wrapper.get('[data-testid="commit-rows"]').attributes("tabindex")).toBeUndefined();
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1"]);
    (wrapper.vm as unknown as { focus(): void }).focus();
    expect(document.activeElement).toBe(rows[0]?.element);
    await rows[0]!.trigger("keydown", { key: "j" });
    expect(wrapper.emitted("select")?.at(-1)).toEqual([1]);
    expect(document.activeElement).toBe(rows[1]?.element);
    await wrapper.setProps({ selectedIndex: 1 });
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["-1", "0", "-1", "-1", "-1"]);
    await rows[1]!.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")).toEqual([[1]]);
    wrapper.unmount();
  });

  it("asks for more rows when the selection nears the end and more pages exist", async () => {
    const wrapper = mountRows(30, { canLoadMore: true });
    await wrapper.setProps({ selectedIndex: 15 });
    expect(wrapper.emitted("loadMore")).toHaveLength(1);
    await wrapper.setProps({ selectedIndex: 2 });
    expect(wrapper.emitted("loadMore")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows skeleton rows while loading", () => {
    const wrapper = mountRows(2, { loading: true, skeletonRows: 3 });
    expect(wrapper.findAll('[data-testid="skeleton-row"]').length).toBe(3);
    wrapper.unmount();
  });
});
