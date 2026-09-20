import { flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

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
    lane: n % 3,
    edges: [{ fromLane: n % 3, toLane: (n + 1) % 3, parent: "p" }],
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

const ROW = 28;
const VIEWPORT = 280;

/** Mounts the list with a 280px viewport (ten rows) that jsdom cannot measure by itself. */
async function mountRows(count = 30, extra: Record<string, unknown> = {}) {
  const commits = Array.from({ length: count }, (_, i) =>
    commit(i, i === 0 ? ["HEAD", "main", "origin/main"] : i === 3 ? ["v1"] : []),
  );
  const wrapper = mountWithI18n(CommitRows, {
    props: { commits, refs, selectedIndex: 0, ...extra },
    attachTo: document.body,
  });
  const container = wrapper.get('[data-testid="commit-rows"]').element;
  Object.defineProperty(container, "clientHeight", { value: VIEWPORT, configurable: true });
  await wrapper.get('[data-testid="commit-rows"]').trigger("scroll");
  return wrapper;
}

async function scrollTo(wrapper: Awaited<ReturnType<typeof mountRows>>, top: number) {
  const list = wrapper.get('[data-testid="commit-rows"]');
  list.element.scrollTop = top;
  await list.trigger("scroll");
}

describe("CommitRows", () => {
  it("renders the rows of the viewport plus the overscan, with badges, hash and date", async () => {
    const wrapper = await mountRows(1_000);
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    // Ten visible rows and ten of overscan below; the spacer holds the whole list.
    expect(rows).toHaveLength(20);
    expect(rows[0]?.text()).toContain("commit 0");
    expect(rows[0]?.text()).toContain("main");
    expect(rows[0]?.text()).toContain("origin/main");
    expect(rows[0]?.text()).not.toContain("HEAD");
    expect(rows[3]?.text()).toContain("v1");
    expect(rows[1]?.find('[data-testid="graph-row-hash"]').text()).toBe("1000000");
    expect(rows[1]?.find('[data-testid="graph-row-date"]').text()).toBe("1h ago");
    expect(rows[1]?.attributes("style")).toContain(`top: ${ROW}px`);
    const spacer = wrapper.get('[data-testid="commit-rows"] > div');
    expect(spacer.attributes("style")).toContain(`height: ${1_000 * ROW}px`);
    wrapper.unmount();
  });

  it("moves the rendered window with the scroll and keeps the selected row rendered", async () => {
    const wrapper = await mountRows(1_000, { selectedIndex: 2 });
    await scrollTo(wrapper, 500 * ROW);
    const indexes = wrapper
      .findAll('[data-testid="graph-row"]')
      .map((row) => Number(row.attributes("data-index")));
    expect(indexes[0]).toBe(2);
    expect(indexes.slice(1)).toEqual(Array.from({ length: 30 }, (_, i) => 490 + i));
    expect(wrapper.findAll('[data-testid="graph-row"]').length).toBeLessThan(100);
    wrapper.unmount();
  });

  it("moves the selection with j and k and emits select", async () => {
    const wrapper = await mountRows(10);
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
    const wrapper = await mountRows(5);
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    expect(wrapper.get('[data-testid="commit-rows"]').attributes("tabindex")).toBeUndefined();
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1"]);
    (wrapper.vm as unknown as { focus(): void }).focus();
    expect(document.activeElement).toBe(rows[0]?.element);
    await rows[0]!.trigger("keydown", { key: "j" });
    expect(wrapper.emitted("select")?.at(-1)).toEqual([1]);
    await nextTick();
    expect(document.activeElement).toBe(rows[1]?.element);
    await wrapper.setProps({ selectedIndex: 1 });
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["-1", "0", "-1", "-1", "-1"]);
    await rows[1]!.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")).toEqual([[1]]);
    wrapper.unmount();
  });

  it("scrolls a far row into view when the keyboard reaches it and focuses it once rendered", async () => {
    const wrapper = await mountRows(1_000, { selectedIndex: 998 });
    const list = wrapper.get('[data-testid="commit-rows"]');
    (wrapper.vm as unknown as { focus(): void }).focus();
    await list.trigger("keydown", { key: "End" });
    expect(wrapper.emitted("select")?.at(-1)).toEqual([999]);
    await wrapper.setProps({ selectedIndex: 999 });
    await flushPromises();
    expect(list.element.scrollTop).toBe(1_000 * ROW - VIEWPORT);
    const last = wrapper.find('[data-index="999"]');
    expect(last.exists()).toBe(true);
    expect(document.activeElement).toBe(last.element);
    wrapper.unmount();
  });

  it("asks for more rows before the rendered window reaches the loaded end", async () => {
    const wrapper = await mountRows(1_000, { canLoadMore: true });
    expect(wrapper.emitted("loadMore")).toBeUndefined();
    await scrollTo(wrapper, 790 * ROW);
    expect(wrapper.emitted("loadMore")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows skeleton rows below the loaded ones while loading", async () => {
    const wrapper = await mountRows(2, { loading: true, skeletonRows: 3 });
    const skeletons = wrapper.findAll('[data-testid="skeleton-row"]');
    expect(skeletons).toHaveLength(3);
    expect(skeletons[0]?.attributes("style")).toContain(`top: ${2 * ROW}px`);
    wrapper.unmount();
  });

  it("reports the pointer resting on a row, the context menu and the copy shortcut", async () => {
    const wrapper = await mountRows(5);
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    const leaves = wrapper.emitted("rowLeave")?.length ?? 0;
    await rows[2]!.trigger("pointerenter");
    expect(wrapper.emitted("rowEnter")?.[0]?.[0]).toBe(2);
    await rows[2]!.trigger("pointerleave");
    expect(wrapper.emitted("rowLeave")).toHaveLength(leaves + 1);
    // A scroll hides the card too.
    await scrollTo(wrapper, ROW);
    expect(wrapper.emitted("rowLeave")).toHaveLength(leaves + 2);
    await rows[3]!.trigger("contextmenu", { clientX: 200, clientY: 100 });
    expect(wrapper.emitted("select")?.at(-1)).toEqual([3]);
    expect(wrapper.emitted("menu")?.[0]).toEqual([3, 200, 100]);
    const list = wrapper.get('[data-testid="commit-rows"]');
    await list.trigger("keydown", { key: "F10", shiftKey: true });
    expect(wrapper.emitted("menu")?.[1]?.[0]).toBe(0);
    await list.trigger("keydown", { key: "c", ctrlKey: true });
    expect(wrapper.emitted("copyHash")).toEqual([[0]]);
    wrapper.unmount();
  });

  it("draws the lanes of the rendered rows on the canvas and redraws on scroll", async () => {
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
    };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    try {
      const wrapper = await mountRows(1_000);
      await nextTick();
      const canvas = wrapper.get('[data-testid="graph-canvas"]');
      expect(canvas.attributes("style")).toContain(`height: ${VIEWPORT}px`);
      // One dot per rendered row (20), one curve per row's edge.
      expect(context.arc.mock.calls.length).toBeGreaterThanOrEqual(20);
      expect(context.bezierCurveTo.mock.calls.length).toBeGreaterThanOrEqual(20);
      const dots = context.arc.mock.calls.length;
      await scrollTo(wrapper, 500 * ROW);
      await nextTick();
      expect(context.arc.mock.calls.length).toBeGreaterThan(dots);
      wrapper.unmount();
    } finally {
      getContext.mockRestore();
      raf.mockRestore();
    }
  });
});
