import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { fakeBackend, fakeCommit } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";
import { useGraphStore } from "@/stores/graph";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useToastsStore } from "@/stores/toasts";

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
    await wrapper.get('[data-testid="filter-clear"]').trigger("click");
    await settled();
    expect((search.element as HTMLInputElement).value).toBe("");
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(20);
    wrapper.unmount();
  });

  it("fills the active controls and lists the authors seen", async () => {
    fakeBackend();
    await openRepository();
    const wrapper = await mountPanel();
    const author = wrapper.get('[data-testid="filter-author"] select');
    const options = author.findAll("option").map((o) => o.text());
    expect(options).toEqual(["Anyone", "ane", "claude", "iker"]);
    expect(author.attributes("data-active")).toBeUndefined();
    await author.setValue("claude");
    await settled();
    expect(author.attributes("data-active")).toBe("true");
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(10);
    const scope = wrapper.get('[data-testid="filter-scope"] select');
    await scope.setValue("current");
    await settled();
    expect(scope.attributes("data-active")).toBe("true");
    expect(useGraphStore().walkScope).toEqual({ kind: "ref", name: "main" });
    const date = wrapper.get('[data-testid="filter-date"] select');
    expect(date.findAll("option").map((o) => o.text())).toEqual([
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
    expect(card.get('[data-testid="hover-compare"]').attributes("disabled")).toBeDefined();
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
      "Open in terminal",
      "Open in editor",
    ]);
    expect(wrapper.get('[data-testid="menu-compare"]').attributes("aria-disabled")).toBe("true");
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
