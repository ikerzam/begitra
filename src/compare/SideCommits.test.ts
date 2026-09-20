import { flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { AppError } from "@/ipc/errors";
import type { SideList } from "@/stores/compare";
import { fakeCommit } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import SideCommits from "./SideCommits.vue";

function list(overrides: Partial<SideList> = {}): SideList {
  return {
    commits: [fakeCommit(0), fakeCommit(1), fakeCommit(2)],
    loading: false,
    error: null,
    walkId: "w",
    nextIndex: 1,
    done: true,
    ...overrides,
  };
}

async function mountList(props: { list: SideList; count?: number | null }) {
  const wrapper = mountWithI18n(SideCommits, {
    props: { name: "main", count: props.count ?? 3, list: props.list, lane: 1 },
    attachTo: document.body,
  });
  const rows = wrapper.find('[data-testid="side-rows"]');
  if (rows.exists()) {
    Object.defineProperty(rows.element, "clientHeight", { value: 200, configurable: true });
    await rows.trigger("scroll");
  }
  await flushPromises();
  return wrapper;
}

describe("SideCommits", () => {
  it("lists the commits with the count, moves with j/k and opens with Enter", async () => {
    const wrapper = await mountList({ list: list() });
    expect(wrapper.get('[data-testid="side-count"]').text()).toBe("3");
    const rows = wrapper.findAll('[data-testid="graph-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.text()).toContain("fix(auth): commit 0");
    const container = wrapper.get('[data-testid="side-rows"]');
    await container.trigger("keydown", { key: "j" });
    await container.trigger("keydown", { key: "j" });
    await nextTick();
    const selected = wrapper.findAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.text()).toContain("commit 1");
    await container.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")?.[0]).toEqual([fakeCommit(1).hash]);
    wrapper.unmount();
  });

  it("shows skeleton rows while the first page loads, the empty sentence and the error", async () => {
    const loading = await mountList({ list: list({ commits: [], loading: true, done: false }) });
    expect(loading.findAll('[data-testid="skeleton-row"]').length).toBeGreaterThan(0);
    loading.unmount();
    const empty = await mountList({ list: list({ commits: [] }), count: 0 });
    expect(empty.get('[data-testid="side-empty"]').text()).toBe("Nothing only in main");
    empty.unmount();
    const failed = await mountList({
      list: list({
        commits: [],
        error: new AppError("repo.corrupt_object", "object x is missing", "fatal"),
      }),
    });
    expect(failed.text()).toContain("corrupt object");
    failed.unmount();
  });

  it("asks for the next page before the rendered rows reach the loaded end", async () => {
    const wrapper = await mountList({ list: list({ done: false }) });
    expect(wrapper.emitted("loadMore")).toBeTruthy();
    wrapper.unmount();
  });
});
