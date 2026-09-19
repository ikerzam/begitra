import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitNode, Repo } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useOperationsStore } from "@/stores/operations";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useToastsStore } from "@/stores/toasts";
import { mountWithI18n } from "@/test/mount";

import AppShell from "./AppShell.vue";
import HomeEmpty from "./HomeEmpty.vue";
import StatusBar from "./StatusBar.vue";
import { useExternal } from "./useExternal";

const dialogOpen = vi.fn<() => Promise<string | null>>(() => Promise.resolve("/r"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => dialogOpen() }));

const repo: Repo = {
  root: "/r",
  commonDir: "/r/.git",
  currentBranch: "main",
  detached: false,
  isLinkedWorktree: false,
};

function commit(n: number): CommitNode {
  const who = { name: "iker", email: "i@x", time: 1_700_000_000 - n, offsetMinutes: 0 };
  return {
    hash: n.toString(16).padStart(40, "0"),
    parents: [(n + 1).toString(16).padStart(40, "0")],
    author: who,
    committer: who,
    subject: `feat: change ${n}`,
    body: "",
    refs: n === 0 ? ["HEAD", "main"] : [],
    lane: 0,
    edges: [],
    overflow: 0,
  };
}

function backend(
  options: {
    failOpen?: boolean;
    failExternal?: boolean;
    /** The first commit page waits for this promise. */
    walkGate?: Promise<void>;
    /** Every diff ends with this error instead of pages. */
    failDiff?: boolean;
  } = {},
) {
  const calls: string[] = [];
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push(cmd);
    const send = (messages: unknown[], gate?: Promise<void>) => {
      const channel = args["onPage"] as Channel<unknown>;
      const deliver = () => {
        for (const message of messages) channel.onmessage(message);
      };
      if (gate) void gate.then(deliver);
      else queueMicrotask(deliver);
    };
    switch (cmd) {
      case "open_repository":
        if (options.failOpen) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the serialised AppError object
          return Promise.reject({
            code: "repo.not_found",
            message: "No Git repository found at or above /r",
            detail: "fatal: not a git repository",
          });
        }
        return repo;
      case "list_refs":
        return [
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
        ];
      case "walk_commits":
        send(
          [
            {
              kind: "page",
              seq: 0,
              data: { walkId: "w", index: 0, commits: [0, 1, 2].map(commit), done: true },
            },
            { kind: "done" },
          ],
          options.walkGate,
        );
        return null;
      case "diff":
        if (options.failDiff) {
          send([
            {
              kind: "error",
              error: { code: "op.timeout", message: "The operation timed out", detail: "diff" },
            },
          ]);
          return null;
        }
        send([
          {
            kind: "page",
            seq: 0,
            data: {
              additions: 3,
              deletions: 1,
              totalFiles: 2,
              files: [
                {
                  status: "modified",
                  path: "src/app.ts",
                  oldPath: null,
                  similarity: null,
                  additions: 3,
                  deletions: 1,
                  hunks: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 3,
                      header: "@@ -1 +1,3 @@ fn main",
                      lines: [
                        {
                          kind: "context",
                          oldNumber: 1,
                          newNumber: 1,
                          text: "a",
                          spans: [],
                          noNewline: false,
                        },
                        {
                          kind: "added",
                          oldNumber: null,
                          newNumber: 2,
                          text: "b",
                          spans: [],
                          noNewline: false,
                        },
                        {
                          kind: "added",
                          oldNumber: null,
                          newNumber: 3,
                          text: "c",
                          spans: [],
                          noNewline: false,
                        },
                      ],
                    },
                  ],
                  isBinary: false,
                  isLarge: false,
                  isGenerated: false,
                  isTest: false,
                },
                {
                  status: "added",
                  path: "pnpm-lock.yaml",
                  oldPath: null,
                  similarity: null,
                  additions: 0,
                  deletions: 0,
                  hunks: [],
                  isBinary: false,
                  isLarge: false,
                  isGenerated: true,
                  isTest: false,
                },
              ],
            },
          },
          { kind: "done" },
        ]);
        return null;
      case "open_external":
        if (options.failExternal) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the serialised AppError object
          return Promise.reject({
            code: "external.spawn_failed",
            message: "The command could not be started",
            detail: "code /r: program not found",
          });
        }
        return ["code", "/r"];
      case "list_worktrees":
        return [
          {
            path: "/r",
            name: null,
            head: commit(0).hash,
            branch: "main",
            detached: false,
            isMain: true,
            locked: false,
            lockReason: null,
            prunable: false,
          },
          {
            path: "/wt/claude-auth",
            name: "claude-auth",
            head: commit(1).hash,
            branch: "claude/fix-auth",
            detached: false,
            isMain: false,
            locked: false,
            lockReason: null,
            prunable: false,
          },
        ];
      default:
        return null;
    }
  });
  return calls;
}

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
  setShortcutRegistry(undefined);
  dialogOpen.mockReset();
  dialogOpen.mockImplementation(() => Promise.resolve("/r"));
});

describe("HomeEmpty", () => {
  it("offers Open folder… twice and emits", async () => {
    const wrapper = mountWithI18n(HomeEmpty);
    await wrapper.get('[data-testid="home-open-folder"]').trigger("click");
    await wrapper.get('[data-testid="home-empty-open"]').trigger("click");
    expect(wrapper.emitted("openFolder")).toHaveLength(2);
    expect(wrapper.text()).toContain("No repositories yet. Open a folder to start.");
  });
});

describe("StatusBar", () => {
  it("shows the empty hints, then the branch, path, counts and progress", async () => {
    backend();
    const wrapper = mountWithI18n(StatusBar);
    expect(wrapper.text()).toContain("No repositories");
    expect(wrapper.get('[data-testid="status-hints"]').text()).toContain("Ctrl K");
    const store = useRepoStore();
    await store.open("/r");
    await settle();
    const operations = useOperationsStore();
    operations.start("walk-x", "operations.loadingHistory");
    await flushPromises();
    expect(wrapper.get('[data-testid="status-operation"]').text()).toContain("Loading history");
    operations.finish("walk-x");
    await flushPromises();
    expect(wrapper.get('[data-testid="status-branch"]').text()).toContain("main");
    expect(wrapper.get('[data-testid="status-path"]').text()).toBe("/r");
    expect(wrapper.text()).toContain("2");
    expect(useOperationsStore().isBusy).toBe(false);
    expect(wrapper.get('[data-testid="status-hints"]').text()).toContain("commits");
    wrapper.unmount();
  });
});

describe("AppShell", () => {
  it("opens a folder from the picker, lists branches, streams commits and shows the detail", async () => {
    const calls = backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(true);
    await wrapper.get('[data-testid="home-empty-open"]').trigger("click");
    await settle();
    expect(calls).toContain("open_repository");
    expect(wrapper.get('[data-testid="top-bar"]').text()).toContain("r");
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="branch-list"]').text()).toContain("origin/main");
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(3);
    expect(wrapper.get('[data-testid="commit-subject"]').text()).toBe("feat: change 0");
    expect(wrapper.get('[data-testid="detail-stats"]').text()).toContain("2 files");
    expect(wrapper.get('[data-testid="file-list"]').text()).toContain("app.ts");
    wrapper.unmount();
  });

  it("leaves the focus in the search box when the first page arrives while typing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend({ walkGate: gate });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await wrapper.get('[data-testid="home-empty-open"]').trigger("click");
    await settle();
    // The repository is open, the rows have not arrived: the user starts a search.
    const search = wrapper.get('[data-testid="graph-filters"] input').element as HTMLInputElement;
    search.focus();
    expect(document.activeElement).toBe(search);
    release();
    await settle();
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(3);
    expect(document.activeElement).toBe(search);
    wrapper.unmount();
  });

  it("switches to review focus with the shortcut and collapses the rail below 1100px", async () => {
    backend();
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true }));
    await settle();
    expect(shell.layoutMode).toBe("review");
    expect(wrapper.find('[data-testid="review-focus"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="diff-path"]').text()).toBe("src/app.ts");
    expect(document.activeElement?.getAttribute("data-path")).toBe("src/app.ts");
    expect(wrapper.find('[data-testid="review-rail"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="review-files"]').text()).not.toContain("pnpm-lock.yaml");
    shell.setWindowWidth(1024);
    await flushPromises();
    expect(wrapper.find('[data-testid="review-rail"]').exists()).toBe(false);
    await wrapper.get('[data-testid="show-overview"]').trigger("click");
    expect(wrapper.find('[data-testid="review-rail"]').exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    await settle();
    expect(wrapper.find('[data-testid="graph-focus"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("moves through the detail tree with j and opens review on the chosen file with Enter", async () => {
    backend();
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    const tree = wrapper.get('[data-testid="detail-panel"] [data-testid="file-list"]');
    const rows = tree.findAll("[data-path]");
    expect(rows.map((row) => row.attributes("data-path"))).toEqual([
      "src/app.ts",
      "pnpm-lock.yaml",
    ]);
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1"]);
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false", "false"]);
    (rows[0]?.element as HTMLElement).focus();
    await rows[0]!.trigger("keydown", { key: "j" });
    await rows[0]!.trigger("keydown", { key: "j" });
    expect(rows[1]?.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows[1]?.element);
    expect(shell.layoutMode).toBe("graph");
    await rows[1]!.trigger("keydown", { key: "Enter" });
    await settle();
    expect(shell.layoutMode).toBe("review");
    const review = useReviewStore();
    expect(review.selectedPath).toBe("pnpm-lock.yaml");
    expect(review.filters.hideLockfiles).toBe(false);
    expect(wrapper.get('[data-testid="diff-path"]').text()).toBe("pnpm-lock.yaml");
    expect(document.activeElement?.getAttribute("data-path")).toBe("pnpm-lock.yaml");
    wrapper.unmount();
  });

  it("opens review on the file clicked in the detail tree", async () => {
    backend();
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    await wrapper.get('[data-testid="detail-panel"] [data-path="src/app.ts"]').trigger("click");
    await settle();
    expect(shell.layoutMode).toBe("review");
    expect(useReviewStore().selectedPath).toBe("src/app.ts");
    expect(wrapper.get('[data-testid="diff-path"]').text()).toBe("src/app.ts");
    wrapper.unmount();
  });

  it("shows the error state with the git output and the Repos tab, and toggles the sidebar with Ctrl B", async () => {
    backend({ failOpen: true });
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await useRepoStore().open("/r");
    await settle();
    expect(shell.sidebarTab).toBe("repos");
    expect(wrapper.get('[data-testid="graph-error"]').text()).toContain(
      "Couldn't open /r. The folder was removed or is no longer a Git repository.",
    );
    expect(wrapper.get('[data-testid="repo-row-error"]').text()).toContain("not found");
    expect(wrapper.get('[data-testid="detail-panel"]').text()).toContain(
      "Nothing to show until the repository opens",
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    await settle();
    expect(shell.sidebarCollapsed).toBe(true);
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sidebar-rail"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("opens the palette with Ctrl K", async () => {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await settle();
    expect(wrapper.find('[data-testid="palette-overlay"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("Sidebar", () => {
  async function openShell() {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await useRepoStore().open("/r");
    await settle();
    return wrapper;
  }

  it("selects no branch on load and moves the selection and the focus with j and k", async () => {
    const wrapper = await openShell();
    const rows = wrapper.get('[data-testid="branch-list"]').findAll('[data-testid="list-row"]');
    expect(rows.map((row) => row.text())).toEqual(["main20", "origin/main"]);
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false", "false"]);
    expect(wrapper.get('[data-testid="branch-list"]').attributes("tabindex")).toBeUndefined();
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1"]);
    (rows[0]?.element as HTMLElement).focus();
    await rows[0]!.trigger("keydown", { key: "j" });
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows[0]?.element);
    await rows[0]!.trigger("keydown", { key: "j" });
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false", "true"]);
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["-1", "0"]);
    expect(document.activeElement).toBe(rows[1]?.element);
    await rows[1]!.trigger("keydown", { key: "ArrowUp" });
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("gives the repos and worktrees lists a tab stop and arrow navigation", async () => {
    const wrapper = await openShell();
    await wrapper.get('[data-testid="tab-repos"]').trigger("click");
    const repoRow = wrapper.get('[data-testid="repo-list"] [data-testid="list-row"]');
    expect(repoRow.attributes("tabindex")).toBe("0");
    expect(repoRow.attributes("aria-selected")).toBe("true");

    await wrapper.get('[data-testid="tab-worktrees"]').trigger("click");
    await settle();
    const rows = wrapper.get('[data-testid="worktree-list"]').findAll('[data-testid="list-row"]');
    expect(rows.map((row) => row.text())).toEqual([
      "main worktreemain",
      "claude-authclaude/fix-auth",
    ]);
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1"]);
    await rows[0]!.trigger("keydown", { key: "ArrowDown" });
    await rows[0]!.trigger("keydown", { key: "ArrowDown" });
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false", "true"]);
    expect(document.activeElement).toBe(rows[1]?.element);
    await rows[1]!.trigger("keydown", { key: "k" });
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("moves between the tabs with the arrow keys", async () => {
    const wrapper = await openShell();
    const shell = useShellStore();
    expect(shell.sidebarTab).toBe("branches");
    expect(wrapper.get('[data-testid="tab-branches"]').attributes("tabindex")).toBe("0");
    expect(wrapper.get('[data-testid="tab-repos"]').attributes("tabindex")).toBe("-1");
    await wrapper.get('[data-testid="tab-branches"]').trigger("keydown", { key: "ArrowRight" });
    expect(shell.sidebarTab).toBe("worktrees");
    expect(document.activeElement).toBe(wrapper.get('[data-testid="tab-worktrees"]').element);
    await wrapper.get('[data-testid="tab-worktrees"]').trigger("keydown", { key: "ArrowRight" });
    expect(shell.sidebarTab).toBe("repos");
    await wrapper.get('[data-testid="tab-repos"]').trigger("keydown", { key: "End" });
    expect(shell.sidebarTab).toBe("worktrees");
    await wrapper.get('[data-testid="tab-worktrees"]').trigger("keydown", { key: "ArrowLeft" });
    expect(shell.sidebarTab).toBe("branches");
    wrapper.unmount();
  });
});

describe("useExternal", () => {
  it("shows the diff error in review focus too", async () => {
    backend({ failDiff: true });
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    await shell.setLayoutMode("review");
    await settle();
    const banner = wrapper.get('[data-testid="review-error"]');
    expect(banner.text()).toContain("took too long");
    wrapper.unmount();
  });

  it("counts reviewed files among the files the rail lists", async () => {
    backend();
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    await shell.setLayoutMode("review");
    await settle();
    const review = useReviewStore();
    review.toggleReviewed("src/app.ts");
    review.toggleReviewed("pnpm-lock.yaml");
    await settle();
    // Lockfiles are hidden by default: one file listed, one of the two marks counts.
    const rail = wrapper.get('[data-testid="review-rail"]');
    expect(rail.text()).toContain("1 of 1 files reviewed");
    review.setFilter("hideLockfiles", false);
    await settle();
    expect(rail.text()).toContain("2 of 2 files reviewed");
    wrapper.unmount();
  });

  it("says so when a parent is not among the loaded commits", async () => {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await useRepoStore().open("/r");
    await settle();
    // Commit 2 is the last loaded row; its parent (commit 3) never arrived.
    useRepoStore().select(2);
    await settle();
    await wrapper.get('[data-testid="parent-link"]').trigger("click");
    const toasts = useToastsStore();
    expect(toasts.toasts.map((toast) => toast.message)).toEqual([
      "That parent is further down than the history loaded so far.",
    ]);
    expect(useRepoStore().selectedIndex).toBe(2);
    wrapper.unmount();
  });

  it("shows a toast when the folder picker cannot open", async () => {
    backend();
    dialogOpen.mockImplementationOnce(() => Promise.reject(new Error("no portal")));
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await wrapper.get('[data-testid="home-empty-open"]').trigger("click");
    await settle();
    const toasts = useToastsStore();
    expect(toasts.toasts[0]?.message).toBe("The folder picker could not be opened.");
    expect(toasts.toasts[0]?.output).toContain("no portal");
    expect(useRepoStore().state.kind).toBe("empty");
    wrapper.unmount();
  });

  it("shows a toast with the command when the editor cannot be spawned", async () => {
    backend({ failExternal: true });
    const wrapper = mountWithI18n({
      template: "<div />",
      setup() {
        return useExternal();
      },
    });
    const store = useRepoStore();
    await store.open("/r");
    await settle();
    const external = wrapper.vm as unknown as ReturnType<typeof useExternal>;
    expect(await external.openEditor()).toBe(false);
    const toasts = useToastsStore();
    expect(toasts.toasts).toHaveLength(1);
    expect(toasts.toasts[0]?.message).toBe(
      "Couldn't open the editor. Check the editor command in Settings.",
    );
    expect(toasts.toasts[0]?.action).toBe("Show command");
    expect(toasts.toasts[0]?.output).toContain("code /r");
    wrapper.unmount();
  });
});
