import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import RefBadge from "@/components/RefBadge.vue";
import type { Ref } from "@/ipc/schemas";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import {
  fakeBackend,
  fakeCommit,
  settled,
  writeGate,
  type FakeBackendOptions,
} from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import ContainedIn from "./ContainedIn.vue";

const COMMIT = fakeCommit(3).hash;

function ref(name: string, kind: Ref["kind"], extra: Partial<Ref> = {}): Ref {
  const prefix =
    kind === "tag" ? "refs/tags/" : kind === "remote-branch" ? "refs/remotes/" : "refs/heads/";
  return {
    name,
    fullName: `${prefix}${name}`,
    kind,
    target: fakeCommit(0).hash,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
    committedAt: null,
    ...extra,
  };
}

const branches = Array.from({ length: 14 }, (_, i) => ref(`claude/task-${i + 1}`, "local-branch"));
const refs: Ref[] = [
  ref("main", "local-branch", { isCurrent: true, upstream: "origin/main" }),
  ...branches,
  ref("origin/main", "remote-branch"),
  ref("v2.4.0", "tag", { committedAt: 2_000 }),
  ref("v2.3.1", "tag", { committedAt: 1_000 }),
];

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(() => {
  vi.useRealTimers();
  clearMocks();
  document.body.innerHTML = "";
});

async function mountLine(options: FakeBackendOptions = {}) {
  fakeBackend({ refs, ...options });
  await useRepoStore().open("/r");
  await settled();
  return mountWithI18n(ContainedIn, {
    props: { commit: COMMIT, refs },
    attachTo: document.body,
  });
}

type Line = Awaited<ReturnType<typeof mountLine>>;

const live = (wrapper: Line) => wrapper.get('[data-testid="contained-live"]').text();

/** Presses the button `id` as a keyboard user does: focused first. */
async function press(wrapper: Line, id: string): Promise<void> {
  const button = wrapper.get(`[data-testid="${id}"]`).element as HTMLElement;
  button.focus();
  button.click();
  await nextTick();
  await nextTick();
}

describe("ContainedIn", () => {
  it("answers on demand: the current branch, its upstream, the tags oldest first, then the rest, twelve before +N more", async () => {
    const gate = writeGate();
    const names = refs.map((entry) => entry.fullName).reverse();
    const wrapper = await mountLine({ containing: { [COMMIT]: names }, containingGate: gate });
    expect(wrapper.text()).toContain("Contained in");
    expect(wrapper.get('[data-testid="contained-find"]').text()).toBe("Find");
    expect(live(wrapper)).toBe("");
    await wrapper.get('[data-testid="contained-find"]').trigger("click");
    await settled();
    expect(wrapper.get('[data-testid="contained-reading"]').text()).toBe("Looking…");
    expect(live(wrapper)).toBe("Looking…");
    gate.release();
    await settled();
    expect(live(wrapper)).toBe("In 18 branches and tags");
    const labels = () =>
      wrapper.findAllComponents(RefBadge).map((badge) => String(badge.props("label")));
    expect(labels().slice(0, 5)).toEqual([
      "main",
      "origin/main",
      "v2.3.1",
      "v2.4.0",
      "claude/task-1",
    ]);
    expect(labels()).toHaveLength(12);
    expect(wrapper.get('[data-testid="contained-more"]').text()).toBe("+6 more");
    await wrapper.get('[data-testid="contained-more"]').trigger("click");
    expect(labels()).toHaveLength(18);
    expect(labels().at(-1)).toBe("claude/task-14");
    expect(wrapper.find('[data-testid="contained-more"]').exists()).toBe(false);
  });

  it("hands the focus to the line when the pressed button leaves", async () => {
    const gate = writeGate();
    const names = refs.map((entry) => entry.fullName);
    const wrapper = await mountLine({ containing: { [COMMIT]: names }, containingGate: gate });
    const root = wrapper.get('[data-testid="contained-in"]').element;
    await press(wrapper, "contained-find");
    expect(document.activeElement).toBe(root);
    gate.release();
    await settled();
    await press(wrapper, "contained-more");
    expect(document.activeElement).toBe(root);
  });

  it("counts the seconds of a long read after two, ticking only while it reads", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const wrapper = await mountLine({ containingGate: writeGate() });
    expect(vi.getTimerCount()).toBe(0);
    await wrapper.get('[data-testid="contained-find"]').trigger("click");
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(wrapper.get('[data-testid="contained-reading"]').text()).toBe("Looking…");
    vi.advanceTimersByTime(11_000);
    await flushPromises();
    expect(wrapper.get('[data-testid="contained-reading"]').text()).toBe("Looking… 12 s");
  });

  it("says when no branch or tag holds the commit", async () => {
    const wrapper = await mountLine({ containing: { [COMMIT]: [] } });
    await wrapper.get('[data-testid="contained-find"]').trigger("click");
    await settled();
    expect(wrapper.get('[data-testid="contained-none"]').text()).toBe("No branch or tag");
    expect(live(wrapper)).toBe("No branch or tag");
  });

  it("says a read failed, with git's output a click away and another try", async () => {
    const gate = writeGate();
    const wrapper = await mountLine({ containingGate: gate });
    await wrapper.get('[data-testid="contained-find"]').trigger("click");
    await settled();
    gate.refuse();
    await settled();
    expect(wrapper.text()).toContain("Couldn't read them.");
    expect(live(wrapper)).toBe("Couldn't read them.");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="contained-output"]').exists()).toBe(false);
    await wrapper.get('[data-testid="contained-output-toggle"]').trigger("click");
    expect(wrapper.get('[data-testid="contained-output"]').text()).toContain("index.lock");
    await press(wrapper, "contained-retry");
    expect(document.activeElement).toBe(wrapper.get('[data-testid="contained-in"]').element);
    await settled();
    expect(wrapper.find('[data-testid="contained-reading"]').exists()).toBe(true);
    expect(gate.waiting).toEqual(["refs_containing"]);
  });

  it("offers no git output when git said nothing, as for a read that ran out of time", async () => {
    const wrapper = await mountLine({
      containingFailure: { code: "op.timeout", message: "refs_containing took longer than 120 s" },
    });
    await wrapper.get('[data-testid="contained-find"]').trigger("click");
    await settled();
    expect(wrapper.text()).toContain("Couldn't read them.");
    expect(wrapper.find('[data-testid="contained-output-toggle"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="contained-retry"]').exists()).toBe(true);
  });

  it("says nothing of a commit it moves to, and folds the list again", async () => {
    const names = refs.map((entry) => entry.fullName);
    const other = fakeCommit(4).hash;
    const wrapper = await mountLine({ containing: { [COMMIT]: names, [other]: names } });
    await wrapper.get('[data-testid="contained-find"]').trigger("click");
    await settled();
    await wrapper.get('[data-testid="contained-more"]').trigger("click");
    await wrapper.setProps({ commit: other });
    expect(live(wrapper)).toBe("");
    await wrapper.get('[data-testid="contained-find"]').trigger("click");
    await settled();
    await wrapper.setProps({ commit: COMMIT });
    expect(live(wrapper)).toBe("");
    expect(wrapper.find('[data-testid="contained-more"]').exists()).toBe(true);
  });
});
