// The branch cleanup on screen: opened from the Branches header and from the palette, its
// rows ticked or not, the confirm with its counts, the toast with the commands that bring the
// branches back, and the loading, empty and error states.

import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import type { CleanupCandidate, Ref, Worktree } from "@/ipc/schemas";
import PaletteOverlay from "@/palette/PaletteOverlay.vue";
import Sidebar from "@/shell/Sidebar.vue";
import ToastHost from "@/shell/ToastHost.vue";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts } from "@/shortcuts/useShortcut";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import {
  fakeBackend,
  fakeCommit,
  fakeWorktrees,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import BranchDialogs from "./BranchDialogs.vue";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));

function local(name: string, n: number, worktree: string | null = null): Ref {
  return {
    name,
    fullName: `refs/heads/${name}`,
    kind: "local-branch",
    target: fakeCommit(n).hash,
    isCurrent: name === "main",
    upstream: null,
    ahead: null,
    behind: null,
    worktree,
    message: null,
    committedAt: null,
  };
}

const candidates: CleanupCandidate[] = [
  {
    name: "claude/fix-auth",
    tip: fakeCommit(4).hash,
    reason: "gone-applied",
    remote: "origin",
    worktree: "/wt/claude-auth",
  },
  {
    name: "feature/tiles",
    tip: fakeCommit(2).hash,
    reason: "merged",
    remote: null,
    worktree: null,
  },
  {
    name: "review-2.4",
    tip: fakeCommit(7).hash,
    reason: "merged",
    remote: "origin",
    worktree: "/wt/review",
  },
  {
    name: "spike/maplibre",
    tip: fakeCommit(5).hash,
    reason: "gone",
    remote: "origin",
    worktree: null,
  },
];

const review: Worktree = {
  path: "/wt/review",
  name: "review",
  head: fakeCommit(7).hash,
  branch: "review-2.4",
  detached: false,
  isMain: false,
  locked: true,
  lockReason: null,
  prunable: false,
  bare: false,
};

const Screen = defineComponent({
  setup() {
    const shell = useShellStore();
    return () =>
      h("div", [
        h(Sidebar),
        h(BranchDialogs),
        h(ToastHost),
        shell.paletteOpen ? h(PaletteOverlay) : null,
      ]);
  },
});

let uninstall: () => void = () => {};

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
  setShortcutRegistry(new ShortcutRegistry("windows"));
  uninstall = installShortcuts(window);
});

afterEach(() => {
  uninstall();
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

async function mountScreen(options: FakeBackendOptions = {}) {
  const all: FakeBackendOptions = {
    refs: [
      local("main", 0, "/r"),
      local("claude/fix-auth", 4, "/wt/claude-auth"),
      local("feature/tiles", 2),
      local("review-2.4", 7, "/wt/review"),
      local("spike/maplibre", 5),
    ],
    worktrees: [...fakeWorktrees(), review],
    cleanup: { main: "main", candidates: candidates.map((entry) => ({ ...entry })) },
    ...options,
  };
  const calls = fakeBackend(all);
  await useRepoStore().open("/r");
  await settled();
  const wrapper = mountWithI18n(Screen, { attachTo: document.body });
  await settled();
  return { wrapper, calls, options: all };
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

const dialog = (wrapper: VueWrapper) => wrapper.find('[data-testid="cleanup-dialog"]');
const row = (wrapper: VueWrapper, name: string) =>
  wrapper.get(`[data-testid="cleanup-row"][data-name="${name}"]`);
const box = (wrapper: VueWrapper, name: string) =>
  row(wrapper, name).get<HTMLInputElement>('input[type="checkbox"]');
const confirmButton = (wrapper: VueWrapper) => wrapper.get('[data-testid="dialog-confirm"]');

async function openFromHeader(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-testid="branch-cleanup"]').trigger("click");
  await settled();
}

describe("branch cleanup", () => {
  it("lists each branch with its reason and worktree, the merged and applied ones ticked", async () => {
    const { wrapper } = await mountScreen();
    expect(wrapper.get('[data-testid="branch-cleanup"]').attributes("aria-label")).toBe(
      "Clean up branches…",
    );
    await openFromHeader(wrapper);
    expect(dialog(wrapper).text()).toContain("Clean up branches");
    expect(dialog(wrapper).text()).toContain(
      "Branches merged into main, or gone from their remote. A branch's worktree goes with it, its folder deleted with the files git ignores in it; the toast keeps the commands that bring each branch back.",
    );
    const reasons = wrapper
      .findAll('[data-testid="cleanup-reason"]')
      .map((reason) => reason.text());
    expect(reasons).toEqual([
      "Gone from origin, its changes in main · worktree /wt/claude-auth",
      "Merged into main",
      "Merged into main · worktree /wt/review is locked",
      "Gone from origin, not in main",
    ]);
    expect(box(wrapper, "claude/fix-auth").element.checked).toBe(true);
    expect(box(wrapper, "feature/tiles").element.checked).toBe(true);
    expect(box(wrapper, "review-2.4").element.disabled).toBe(true);
    expect(box(wrapper, "review-2.4").element.checked).toBe(false);
    expect(box(wrapper, "spike/maplibre").element.checked).toBe(false);
    // Only the gone branch main lacks carries the warning.
    expect(row(wrapper, "spike/maplibre").find('[data-testid="cleanup-warn"]').exists()).toBe(true);
    expect(row(wrapper, "claude/fix-auth").find('[data-testid="cleanup-warn"]').exists()).toBe(
      false,
    );
    expect(confirmButton(wrapper).text()).toBe("Delete 2 branches and 1 worktree");
    // The first listing takes the focus to the list's first box.
    expect(document.activeElement).toBe(box(wrapper, "claude/fix-auth").element);
  });

  it("unticks a row with a click, confirms, and the toast keeps the commands", async () => {
    const { wrapper, calls } = await mountScreen();
    await openFromHeader(wrapper);
    await wrapper.get('[data-name="feature/tiles"] [data-testid="cleanup-name"]').trigger("click");
    await nextTick();
    expect(box(wrapper, "feature/tiles").element.checked).toBe(false);
    expect(confirmButton(wrapper).text()).toBe("Delete 1 branch and its worktree");
    await confirmButton(wrapper).trigger("click");
    await settled();
    expect(dialog(wrapper).exists()).toBe(false);
    expect(of(calls, "delete_branches").map((call) => call.args["branches"])).toEqual([
      [{ name: "claude/fix-auth", tip: fakeCommit(4).hash, worktree: "/wt/claude-auth" }],
    ]);
    const toast = wrapper.get('[data-testid="toast-message"]');
    expect(toast.text()).toBe("Deleted 1 branch and 1 worktree");
    const action = wrapper.get('[data-testid="toast-action"]');
    expect(action.text()).toBe("Show commands");
    await action.trigger("click");
    expect(wrapper.get('[data-testid="toast-output"]').text()).toBe(
      `git branch claude/fix-auth ${fakeCommit(4).hash}`,
    );
  });

  it("moves between the boxes with the arrows past a locked row, and ticks with Space", async () => {
    const { wrapper } = await mountScreen();
    await openFromHeader(wrapper);
    const list = wrapper.get('[data-testid="cleanup-list"]');
    await list.trigger("keydown", { key: "ArrowDown" });
    await list.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(box(wrapper, "spike/maplibre").element);
    // One tab stop: the focused box.
    expect(
      wrapper
        .findAll<HTMLInputElement>('[data-testid="cleanup-row"] input')
        .filter((input) => input.element.tabIndex === 0)
        .map((input) => input.element),
    ).toEqual([box(wrapper, "spike/maplibre").element]);
    await box(wrapper, "spike/maplibre").setValue(true);
    expect(confirmButton(wrapper).text()).toBe("Delete 3 branches and 1 worktree");
    // Home and End go to the first and the last box that can be ticked.
    await list.trigger("keydown", { key: "Home" });
    expect(document.activeElement).toBe(box(wrapper, "claude/fix-auth").element);
    await list.trigger("keydown", { key: "End" });
    expect(document.activeElement).toBe(box(wrapper, "spike/maplibre").element);
  });

  it("takes the focus back to the list after Fetch and prune lists again", async () => {
    const { wrapper, options } = await mountScreen();
    await openFromHeader(wrapper);
    options.networkDelayMs = 30;
    const fetch = wrapper.get<HTMLButtonElement>('[data-testid="cleanup-fetch"]').element;
    fetch.focus();
    await wrapper.get('[data-testid="cleanup-fetch"]').trigger("click");
    expect(fetch.disabled).toBe(true);
    // Chromium takes the focus off the button the fetch disables, and the dialog takes it back
    // on its panel (Dialog's own test); jsdom leaves it on the disabled button.
    wrapper.get<HTMLElement>('[role="dialog"]').element.focus();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settled();
    expect(document.activeElement).toBe(box(wrapper, "claude/fix-auth").element);
  });

  it("leaves the focus where the user moved it while the list reads", async () => {
    const gate = writeGate();
    const { wrapper, options } = await mountScreen();
    options.listingGate = gate;
    await openFromHeader(wrapper);
    const cancel = wrapper.get<HTMLButtonElement>('[data-testid="dialog-cancel"]').element;
    cancel.focus();
    while (gate.waiting.length > 0) gate.release();
    await settled();
    expect(wrapper.findAll('[data-testid="cleanup-row"]')).toHaveLength(4);
    expect(document.activeElement).toBe(cancel);
  });

  it("opens from the palette", async () => {
    const { wrapper } = await mountScreen();
    useShellStore().openPalette();
    await nextTick();
    const input = wrapper.get('[data-testid="palette-input"]');
    await input.setValue("clean up");
    await input.trigger("keydown", { key: "Enter" });
    await settled();
    expect(dialog(wrapper).exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="cleanup-row"]')).toHaveLength(4);
  });

  it("reads with skeleton rows, the confirm off", async () => {
    const gate = writeGate();
    const { wrapper, options } = await mountScreen();
    options.listingGate = gate;
    await openFromHeader(wrapper);
    expect(wrapper.find('[data-testid="cleanup-loading"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="cleanup-status"]').text()).toBe("Reading the branches");
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
    expect(confirmButton(wrapper).text()).toBe("Delete branches");
    while (gate.waiting.length > 0) gate.release();
    await settled();
    expect(wrapper.find('[data-testid="cleanup-loading"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="cleanup-row"]')).toHaveLength(4);
    expect(wrapper.get('[data-testid="cleanup-status"]').text()).toBe("");
    // Opened again, it reads from nothing: no rows, no counts of the last listing.
    await wrapper.get('[data-testid="dialog-cancel"]').trigger("click");
    await openFromHeader(wrapper);
    expect(wrapper.find('[data-testid="cleanup-loading"]').exists()).toBe(true);
    expect(confirmButton(wrapper).text()).toBe("Delete branches");
    while (gate.waiting.length > 0) gate.release();
    await settled();
  });

  it("says when there is nothing to clean up, and fetches with prune to look again", async () => {
    const { wrapper, calls } = await mountScreen({ cleanup: { main: "main", candidates: [] } });
    await openFromHeader(wrapper);
    expect(wrapper.get('[data-testid="cleanup-empty"]').text()).toBe(
      "Nothing to clean up: no branch is merged into main or gone from its remote.",
    );
    // A screen reader hears it too.
    expect(wrapper.get('[data-testid="cleanup-status"]').text()).toBe(
      "Nothing to clean up: no branch is merged into main or gone from its remote.",
    );
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
    await wrapper.get('[data-testid="cleanup-fetch"]').trigger("click");
    await settled();
    await flushPromises();
    expect(of(calls, "fetch").map((call) => call.args["prune"])).toEqual([true]);
    expect(of(calls, "cleanup_candidates")).toHaveLength(2);
  });

  it("says when no main branch is found, and how to name one", async () => {
    const { wrapper } = await mountScreen({ cleanup: { main: null, candidates: [] } });
    await openFromHeader(wrapper);
    expect(wrapper.get('[data-testid="cleanup-empty"]').text()).toBe(
      "Nothing to compare with: no main or master branch, and origin/HEAD names none here. git remote set-head origin --auto sets it from the remote.",
    );
    expect(dialog(wrapper).text()).toContain("Branches merged into the main branch");
  });

  it("lists a branch with no commits of its own unticked, with its worktree", async () => {
    const { wrapper } = await mountScreen({
      cleanup: {
        main: "main",
        candidates: [
          {
            name: "claude/fix-auth",
            tip: fakeCommit(0).hash,
            reason: "no-commits",
            remote: null,
            worktree: "/wt/claude-auth",
          },
        ],
      },
    });
    await openFromHeader(wrapper);
    expect(row(wrapper, "claude/fix-auth").get('[data-testid="cleanup-reason"]').text()).toBe(
      "No commits of its own · worktree /wt/claude-auth",
    );
    expect(box(wrapper, "claude/fix-auth").element.checked).toBe(false);
    expect(confirmButton(wrapper).text()).toBe("Delete branches");
  });

  it("says when the merge check did not answer for a gone branch, unticked with the warning", async () => {
    const { wrapper } = await mountScreen({
      cleanup: {
        main: "main",
        candidates: [
          {
            name: "spike/old-tiles",
            tip: fakeCommit(5).hash,
            reason: "gone-unchecked",
            remote: "origin",
            worktree: null,
          },
          {
            name: "spike/local",
            tip: fakeCommit(2).hash,
            reason: "gone-unchecked",
            remote: null,
            worktree: null,
          },
        ],
      },
    });
    await openFromHeader(wrapper);
    expect(row(wrapper, "spike/old-tiles").get('[data-testid="cleanup-reason"]').text()).toBe(
      "Gone from origin, not checked against main",
    );
    expect(row(wrapper, "spike/local").get('[data-testid="cleanup-reason"]').text()).toBe(
      "Its upstream is gone, not checked against main",
    );
    expect(row(wrapper, "spike/old-tiles").find('[data-testid="cleanup-warn"]').exists()).toBe(
      true,
    );
    expect(box(wrapper, "spike/old-tiles").element.checked).toBe(false);
    expect(box(wrapper, "spike/local").element.checked).toBe(false);
  });

  it("shows a failed listing with git's output one click away", async () => {
    const { wrapper } = await mountScreen({
      cleanupErrors: {
        list: { code: "git.cli_failed", message: "git for-each-ref failed", detail: "fatal: bad" },
      },
    });
    await openFromHeader(wrapper);
    const banner = wrapper.get('[data-testid="cleanup-error"]');
    expect(banner.text()).toContain(
      "Could not list the branches: git reported an error. git for-each-ref failed",
    );
    await banner.get('[data-testid="error-banner-toggle"]').trigger("click");
    expect(banner.get('[data-testid="error-banner-output"]').text()).toBe("fatal: bad");
  });

  it("lists again from the error banner's Try again", async () => {
    const { wrapper, calls, options } = await mountScreen({
      cleanupErrors: {
        list: { code: "git.cli_failed", message: "git for-each-ref failed", detail: "fatal: bad" },
      },
    });
    await openFromHeader(wrapper);
    options.cleanupErrors = undefined;
    const retry = wrapper
      .findAll('[data-testid="cleanup-error"] button')
      .find((button) => button.text() === "Try again");
    await retry?.trigger("click");
    await settled();
    expect(of(calls, "cleanup_candidates")).toHaveLength(2);
    expect(wrapper.find('[data-testid="cleanup-error"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="cleanup-row"]')).toHaveLength(4);
  });

  it("closes with Escape and cancels the listing", async () => {
    const gate = writeGate();
    const { wrapper, calls, options } = await mountScreen();
    options.listingGate = gate;
    await openFromHeader(wrapper);
    await wrapper.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(dialog(wrapper).exists()).toBe(false);
    const opId = of(calls, "cleanup_candidates")[0]?.args["opId"];
    expect(of(calls, "cancel_operation").map((call) => call.args["opId"])).toContain(opId);
    while (gate.waiting.length > 0) gate.release();
    await settled();
    expect(dialog(wrapper).exists()).toBe(false);
  });
});
