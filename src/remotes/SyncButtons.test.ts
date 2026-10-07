import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Ref as GitRef, Remote } from "@/ipc/schemas";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useToastsStore } from "@/stores/toasts";
import { fakeBackend, fakeCommit, type FakeBackendOptions } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import SyncButtons from "./SyncButtons.vue";

const NOW = 1_700_000_000;

const origin = (fetchedAt: number | null = null): Remote => ({
  name: "origin",
  fetchUrl: "https://example.com/origin/r.git",
  pushUrl: "https://example.com/origin/r.git",
  fetchedAt,
});

const main = (over: Partial<GitRef> = {}): GitRef => ({
  name: "main",
  fullName: "refs/heads/main",
  kind: "local-branch",
  target: fakeCommit(0).hash,
  isCurrent: true,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  worktree: "/r",
  message: null,
  committedAt: fakeCommit(0).committer.time,
  ...over,
});

/** Flushes the microtasks of the fake backend and the zero-delay timers (timers are faked). */
async function settled(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  vi.advanceTimersByTime(0);
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function mountButtons(options: FakeBackendOptions) {
  const calls = fakeBackend({ remotes: [origin()], ...options });
  await useRepoStore().open("/r");
  await settled();
  const wrapper = mountWithI18n(SyncButtons, { attachTo: document.body });
  await settled();
  const button = (name: "fetch" | "pull" | "push") => wrapper.get(`[data-testid="sync-${name}"]`);
  const of = (cmd: string) => calls.filter((call) => call.cmd === cmd);
  return { wrapper, calls, button, of };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("SyncButtons", () => {
  it("fetches every remote, saying when the repository last fetched", async () => {
    const { wrapper, button, of } = await mountButtons({ remotes: [origin(NOW - 300)] });
    const fetch = button("fetch");
    expect(fetch.attributes("aria-label")).toBe("Fetch");
    expect(fetch.attributes("data-tooltip")).toBe("Fetch all remotes (fetched 5m ago)");
    expect(fetch.attributes("data-tooltip-keys")).toBe("Ctrl Shift F");
    await fetch.trigger("click");
    await settled();
    expect(of("fetch")[0]?.args).toMatchObject({ remote: null, prune: false });
    wrapper.unmount();
  });

  it("pulls a branch that is behind as a fast-forward, with the commits to bring", async () => {
    const { wrapper, button, of } = await mountButtons({ refs: [main({ behind: 3 })] });
    const pull = button("pull");
    expect(pull.attributes("aria-label")).toBe("Pull, 3 commits to bring");
    expect(pull.attributes("data-tooltip")).toBe("Pull origin/main into main");
    expect(pull.get('[data-testid="icon-button-count"]').text()).toBe("3");
    await pull.trigger("click");
    await settled();
    expect(of("pull")[0]?.args["request"]).toEqual({
      remote: null,
      branch: null,
      rebase: false,
      ffOnly: true,
    });
    wrapper.unmount();
  });

  it("opens the pull dialog on a branch that diverged, pulling nothing", async () => {
    const { wrapper, button, of } = await mountButtons({
      refs: [main({ ahead: 1, behind: 2 })],
    });
    expect(button("pull").attributes("data-tooltip")).toBe(
      "main and origin/main diverged: pull with a merge or a rebase…",
    );
    await button("pull").trigger("click");
    await settled();
    expect(of("pull")).toHaveLength(0);
    expect(useRemotesStore().prompt).toEqual({ kind: "pull", branch: "main" });
    wrapper.unmount();
  });

  it("says a fast-forward git refused diverged, and offers Pull…", async () => {
    const { wrapper, button } = await mountButtons({
      refs: [main({ ahead: 1 })],
      networkErrors: {
        "/r": {
          code: "git.cli_failed",
          message: "git merge failed",
          detail: "fatal: Not possible to fast-forward, aborting.",
        },
      },
    });
    await button("pull").trigger("click");
    await settled();
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.key).toBe("remotes.pullDiverged");
    expect(toast?.params).toEqual({ branch: "main", upstream: "origin/main" });
    expect(toast?.actionKey).toBe("remotes.pullAction");
    toast?.onAction?.();
    expect(useRemotesStore().prompt).toEqual({ kind: "pull", branch: "main" });
    wrapper.unmount();
  });

  it("pushes a branch ahead of its upstream without a dialog, with the commits to send", async () => {
    const { wrapper, button, of } = await mountButtons({ refs: [main({ ahead: 2 })] });
    const push = button("push");
    expect(push.attributes("aria-label")).toBe("Push, 2 commits to send");
    expect(push.attributes("data-tooltip")).toBe("Push main to origin/main");
    // ⇧⌘P opens the push dialog: the button names no key.
    expect(push.attributes("data-tooltip-keys")).toBeUndefined();
    await push.trigger("click");
    await settled();
    expect(of("push")[0]?.args["request"]).toEqual({
      remote: "origin",
      branch: "main",
      tag: null,
      delete: false,
      setUpstream: false,
      forceWithLease: false,
    });
    expect(useRemotesStore().prompt).toBeNull();
    wrapper.unmount();
  });

  it("publishes a branch without upstream to the only remote", async () => {
    const { wrapper, button, of } = await mountButtons({ refs: [main({ upstream: null })] });
    const push = button("push");
    expect(push.attributes("data-tooltip")).toBe("Publish main to origin");
    await push.trigger("click");
    await settled();
    expect(of("push")[0]?.args["request"]).toMatchObject({ remote: "origin", setUpstream: true });
    expect(button("pull").attributes("data-tooltip")).toBe("main has no upstream to pull from.");
    wrapper.unmount();
  });

  it("is unavailable with its reason, and a press does nothing", async () => {
    const { wrapper, button, calls } = await mountButtons({ refs: [main()] });
    const push = button("push");
    expect(push.attributes("aria-disabled")).toBe("true");
    expect(push.attributes("data-tooltip")).toBe(
      "main is level with origin/main: nothing to push.",
    );
    const before = calls.length;
    await push.trigger("click");
    await settled();
    expect(calls.length).toBe(before);
    expect(button("pull").attributes("aria-disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("is unavailable on a detached HEAD for Pull and Push, and Fetch still runs", async () => {
    const head: GitRef = {
      ...main({ isCurrent: false }),
      name: "HEAD",
      fullName: "HEAD",
      kind: "head",
    };
    const { wrapper, button } = await mountButtons({
      refs: [head, main({ isCurrent: false })],
      detachedHead: true,
    });
    expect(button("pull").attributes("data-tooltip")).toBe(
      "A detached HEAD has no branch to pull into.",
    );
    expect(button("push").attributes("data-tooltip")).toBe(
      "A detached HEAD has no branch to push.",
    );
    expect(button("fetch").attributes("aria-disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("is unavailable while a fetch, pull or push runs", async () => {
    const { wrapper, button } = await mountButtons({
      refs: [main({ ahead: 1 })],
      networkDelayMs: 1000,
    });
    void useRemotesStore().fetch(null, false);
    await settled();
    // The counts stay while the command runs, so the buttons keep their width.
    expect(button("push").get('[data-testid="icon-button-count"]').text()).toBe("1");
    for (const name of ["fetch", "pull", "push"] as const) {
      expect(button(name).attributes("data-tooltip")).toBe(
        "A fetch, pull or push, or a project's bulk action, is running.",
      );
    }
    vi.advanceTimersByTime(1000);
    await settled();
    expect(button("push").attributes("aria-disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("pulls and pushes nothing in one click on a branch whose upstream is gone", async () => {
    const { wrapper, button } = await mountButtons({
      refs: [main({ ahead: null, behind: null })],
    });
    expect(button("pull").attributes("data-tooltip")).toBe(
      "origin/main is gone from its remote: there is nothing to pull.",
    );
    expect(button("push").attributes("data-tooltip")).toBe(
      "origin/main is gone from its remote: Push… publishes main again.",
    );
    expect(button("push").attributes("aria-description")).toBe(
      "origin/main is gone from its remote: Push… publishes main again.",
    );
    wrapper.unmount();
  });

  it("says where each one goes to assistive technology, its key included", async () => {
    const { wrapper, button } = await mountButtons({ refs: [main({ ahead: 2 })] });
    expect(wrapper.get('[data-testid="sync-buttons"]').attributes("aria-label")).toBe(
      "Sync with the remote",
    );
    expect(button("fetch").attributes("aria-description")).toBe(
      "Fetch all remotes (never fetched), Ctrl Shift F",
    );
    expect(button("pull").attributes("aria-description")).toBe(
      "Pull origin/main into main, Ctrl Shift L",
    );
    expect(button("push").attributes("aria-description")).toBe("Push main to origin/main");
    wrapper.unmount();
  });

  it("is unavailable in a repository with no remote", async () => {
    const { wrapper, button } = await mountButtons({
      refs: [main({ upstream: null })],
      remotes: [],
    });
    for (const name of ["fetch", "push"] as const) {
      expect(button(name).attributes("data-tooltip")).toBe("The repository has no remote.");
    }
    wrapper.unmount();
  });
});
