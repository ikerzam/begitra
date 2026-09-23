import type { Channel } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitNode, IndexEntry, Repo } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useGraphStore } from "@/stores/graph";
import { useIndexStore } from "@/stores/index";
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

function indexEntry(path: string, name: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path,
    name,
    kind: "main",
    parentPath: null,
    scanRoot: "/",
    summary: {
      currentBranch: "main",
      detached: false,
      ahead: 2,
      behind: 0,
      lastCommitAt: 1_700_000_000,
      dirty: false,
    },
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: 1_700_000_000,
    missing: false,
    ...over,
  };
}

/** The index the fake backend lists: the repository under test, another one and a worktree. */
const indexEntries: IndexEntry[] = [
  indexEntry("/r", "r", { pinned: true, lastOpenedAt: 1_700_000_500 }),
  indexEntry("/other", "other", {
    summary: { ...indexEntry("/o", "o").summary, currentBranch: "develop" },
  }),
  indexEntry("/wt/claude-auth", "claude-auth", {
    kind: "worktree",
    parentPath: "/r",
    summary: { ...indexEntry("/o", "o").summary, currentBranch: "claude/fix-auth" },
  }),
];

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
    /** `watch_repository` rejects with `watcher.unavailable`. */
    failWatch?: boolean;
    /** The index lists nothing. */
    emptyIndex?: boolean;
    /** A merge stopped on this conflicted path. */
    conflict?: string;
    /** The commit `main` and `origin/main` point at; the test moves it to fake a commit outside. */
    tip?: { index: number };
    /** A file marked reviewed for another content than the diff shows. */
    staleMark?: string;
  } = {},
) {
  const tip = options.tip ?? { index: 0 };
  const calls: string[] = [];
  /** The fake index: forgets drop entries and a gone folder is flagged on refresh. */
  let listed = options.emptyIndex ? [] : indexEntries.map((entry) => ({ ...entry }));
  const handler = (cmd: string, rawArgs?: unknown) => {
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
        return { ...repo, root: args["path"], commonDir: `${args["path"] as string}/.git` };
      case "close_repository":
        return true;
      case "list_refs":
        return [
          {
            name: "main",
            fullName: "refs/heads/main",
            kind: "local-branch",
            target: commit(tip.index).hash,
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
            target: commit(tip.index).hash,
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
                  isLossy: false,
                  oldId: "a1",
                  newId: "b2",
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
                  isLossy: false,
                  oldId: null,
                  newId: "c3",
                },
              ],
            },
          },
          { kind: "done" },
        ]);
        return null;
      case "list_repositories":
        return listed;
      case "forget_repository":
        listed = listed.filter((entry) => entry.path !== args["path"]);
        return null;
      case "refresh_repository":
        if (options.failOpen) {
          listed = listed.map((entry) =>
            entry.path === args["path"] ? { ...entry, missing: true } : entry,
          );
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          return Promise.reject({
            code: "repo.not_found",
            message: "No Git repository found at or above /r",
          });
        }
        return {
          ...indexEntry(args["path"] as string, "r"),
          summary: { ...indexEntry("/r", "r").summary, ahead: 7 },
        };
      case "watch_repository":
        if (options.failWatch) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          return Promise.reject({
            code: "watcher.unavailable",
            message: "Changes in this repository will not be detected automatically",
            detail: "inotify limit reached",
          });
        }
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
      case "compare":
        return {
          a: { rev: args["a"], hash: commit(0).hash },
          b: { rev: args["b"], hash: commit(2).hash },
          base: { hash: commit(2).hash, time: 1_700_000_000 },
          onlyInA: 2,
          onlyInB: 0,
          relation: "up-to-date",
        };
      case "merge_preview":
        return { kind: "up-to-date", conflicts: [] };
      case "commit_context":
        return {
          author: "Iker Z. <iker@x>",
          template: null,
          headMessage: "feat: change 0",
          unborn: false,
          operation: options.conflict ? "merge" : "none",
          preparedMessage: options.conflict ? "Merge branch 'develop'" : null,
        };
      case "operation_state":
        return options.conflict ? "merge" : "none";
      case "conflicts":
        return options.conflict ? [{ path: options.conflict, kind: "both-modified" }] : [];
      case "mark_resolved":
      case "switch":
        return null;
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
      case "list_annotations":
        return options.staleMark
          ? [
              {
                path: options.staleMark,
                hunk: "",
                kind: "reviewed",
                value: "old:blob",
                updatedAt: 1,
              },
            ]
          : [];
      default:
        return null;
    }
  };
  mockIPC(handler, { shouldMockEvents: true });
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
  it("offers Open folder… in the header, Add a folder to scan in the centre, and emits", async () => {
    const wrapper = mountWithI18n(HomeEmpty);
    await wrapper.get('[data-testid="home-open-folder"]').trigger("click");
    await wrapper.get('[data-testid="home-empty-add"]').trigger("click");
    expect(wrapper.emitted("openFolder")).toHaveLength(1);
    expect(wrapper.emitted("addFolder")).toHaveLength(1);
    expect(wrapper.findAll("button")).toHaveLength(2);
    expect(wrapper.text()).toContain(
      "No repositories yet. Add a folder to scan, or open one directly.",
    );
    expect(wrapper.text()).toContain("Scan a folder to find every repository and worktree");
  });
});

describe("launch and the watcher", () => {
  it("reopens the last repository, watches it and refreshes on repo:changed", async () => {
    await useSettingsStore().init(memoryStorage({ lastRepository: "/r" }), "windows");
    const calls = backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    const repo = useRepoStore();
    expect(repo.repo?.root).toBe("/r");
    expect(calls).toContain("watch_repository");
    expect(calls.filter((c) => c === "list_refs")).toHaveLength(1);
    await emit("repo:changed", { repo: "/r", kinds: ["status"], paths: ["a.ts"] });
    await settle();
    expect(calls.filter((c) => c === "list_refs")).toHaveLength(1);
    expect(calls.filter((c) => c === "refresh_repository")).toHaveLength(1);
    expect(useIndexStore().find("/r")?.summary.ahead).toBe(7);
    await emit("repo:changed", { repo: "/r", kinds: ["refs"], paths: [] });
    await settle();
    expect(calls.filter((c) => c === "list_refs")).toHaveLength(2);
    await emit("repo:changed", { repo: "/elsewhere", kinds: ["refs"], paths: [] });
    await settle();
    expect(calls.filter((c) => c === "list_refs")).toHaveLength(2);
    const worktreeListings = calls.filter((c) => c === "list_worktrees").length;
    await emit("repo:changed", { repo: "/r", kinds: ["worktrees"], paths: [] });
    await settle();
    expect(calls.filter((c) => c === "list_worktrees")).toHaveLength(worktreeListings + 1);
    expect(useSettingsStore().values.lastRepository).toBe("/r");
    wrapper.unmount();
  });

  it("lists the history again when a tip moved outside the app, keeping the selection", async () => {
    await useSettingsStore().init(memoryStorage({ lastRepository: "/r" }), "windows");
    const tip = { index: 0 };
    const calls = backend({ tip });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    const repo = useRepoStore();
    const walks = () => calls.filter((c) => c === "walk_commits").length;
    expect(walks()).toBe(1);
    repo.select(1);
    expect(repo.selectedCommit?.hash).toBe(commit(1).hash);
    // A refs event that moves no tip (a reflog touch, packed-refs rewritten): no new walk.
    await emit("repo:changed", { repo: "/r", kinds: ["refs"], paths: [] });
    await settle();
    expect(walks()).toBe(1);
    // A commit from a terminal: the tip moves, the history is listed again, the selection stays.
    tip.index = 3;
    await emit("repo:changed", { repo: "/r", kinds: ["refs"], paths: [] });
    await settle();
    expect(walks()).toBe(2);
    expect(repo.selectedCommit?.hash).toBe(commit(1).hash);
    // The app's own write listed the history itself: the event that follows does not again.
    repo.restartWalk(repo.walkScope, repo.walkFilter, commit(2).hash);
    await settle();
    expect(walks()).toBe(3);
    tip.index = 4;
    await emit("repo:changed", { repo: "/r", kinds: ["refs"], paths: [] });
    await settle();
    expect(walks()).toBe(3);
    expect(repo.selectedCommit?.hash).toBe(commit(2).hash);
    wrapper.unmount();
  });

  it("reopens on the worktrees dashboard when the app closed there", async () => {
    await useSettingsStore().init(
      memoryStorage({ lastRepository: "/r", layoutMode: "worktrees" }),
      "windows",
    );
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(useRepoStore().repo?.root).toBe("/r");
    expect(useShellStore().layoutMode).toBe("worktrees");
    expect(useShellStore().sidebarTab).toBe("worktrees");
    expect(wrapper.find('[data-testid="worktrees-layout"]').exists()).toBe(true);
    // ⌘1 returns to the graph with the tab still open.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    await settle();
    expect(useShellStore().layoutMode).toBe("graph");
    expect(useShellStore().sidebarTab).toBe("worktrees");
    wrapper.unmount();
  });

  it("leaves the home with the entry flagged and a toast when the last repository is gone", async () => {
    await useSettingsStore().init(memoryStorage({ lastRepository: "/r" }), "windows");
    backend({ failOpen: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(useRepoStore().state.kind).toBe("empty");
    expect(useSettingsStore().values.lastRepository).toBeNull();
    expect(wrapper.find('[data-testid="home-screen"]').exists()).toBe(true);
    const flagged = wrapper
      .findAll('[data-testid="repo-row"]')
      .find((row) => row.get('[data-testid="repo-row-name"]').text() === "r");
    expect(flagged?.get('[data-testid="repo-row-missing"]').text()).toBe("not found");
    const toasts = useToastsStore();
    expect(toasts.toasts[0]?.message).toBe(
      "Couldn't open /r. The folder was removed or is no longer a Git repository.",
    );
    expect(toasts.toasts[0]?.output).toContain("fatal");
    wrapper.unmount();
  });

  it("says so when the watcher cannot start and keeps the repository open", async () => {
    backend({ failWatch: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await useRepoStore().open("/r");
    await settle();
    expect(useRepoStore().state.kind).toBe("ready");
    const toasts = useToastsStore();
    expect(toasts.toasts).toHaveLength(1);
    expect(toasts.toasts[0]?.kind).toBe("info");
    expect(toasts.toasts[0]?.message).toBe(
      "Changes in this repository will not be detected automatically.",
    );
    expect(toasts.toasts[0]?.output).toBe("inotify limit reached");
    wrapper.unmount();
  });

  it("forgets the entry with Remove from list in the error state and goes home", async () => {
    const calls = backend({ failOpen: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await useIndexStore().load();
    await useIndexStore().open("/r");
    await settle();
    expect(useRepoStore().state.kind).toBe("error");
    await wrapper
      .get('[data-testid="graph-error"] button[data-variant="secondary"]')
      .trigger("click");
    await settle();
    expect(calls).toContain("forget_repository");
    expect(useRepoStore().state.kind).toBe("empty");
    expect(useIndexStore().find("/r")).toBeUndefined();
    expect(wrapper.find('[data-testid="home-screen"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("StatusBar", () => {
  it("counts the index and shows the scan with its folder while no repository is open", async () => {
    backend();
    const wrapper = mountWithI18n(StatusBar);
    expect(wrapper.get('[data-testid="status-index"]').text()).toBe("No repositories");
    const index = useIndexStore();
    await index.load();
    await flushPromises();
    expect(wrapper.get('[data-testid="status-index"]').text()).toBe("2 repositories");
    index.scan = {
      kind: "scanning",
      folders: { "/home/iker/code": "scanning" },
      scanned: 10,
      found: 1,
      current: "/home/iker/code",
    };
    useOperationsStore().start("scan-1", "operations.scanning");
    await flushPromises();
    expect(wrapper.get('[data-testid="status-operation"]').text()).toBe("Scanning /home/iker/code");
    expect(wrapper.find('[data-testid="status-operation"] [role="progressbar"]').exists()).toBe(
      true,
    );
    wrapper.unmount();
  });

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
    // The home screen shows its loading rows until the index answers, never the empty Home.
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="home-screen"]').exists()).toBe(true);
    await settle();
    expect(wrapper.find('[data-testid="home-screen"]').exists()).toBe(true);
    await wrapper.get('[data-testid="home-open-folder"]').trigger("click");
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
    await settle();
    await wrapper.get('[data-testid="home-open-folder"]').trigger("click");
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

  it("opens the comparison from the shortcut, shows its layout and hints, and restores it", async () => {
    backend();
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    // ⇧⌘C with the first commit selected opens the picker with that commit as A.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true }));
    await settle();
    const title = wrapper.get('[data-testid="picker-title"]').text();
    expect(title).toBe(`Compare ${commit(0).hash.slice(0, 7)} with…`);
    // Choosing a branch opens the compare layout on it.
    const input = wrapper.get('[data-testid="picker-input"]');
    await input.setValue("origin/main");
    await input.trigger("keydown", { key: "Enter" });
    await settle();
    expect(shell.layoutMode).toBe("compare");
    expect(wrapper.find('[data-testid="compare-layout"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="compare-endpoint-b"]').text()).toBe("origin/main");
    expect(wrapper.get('[data-testid="merge-preview-up-to-date"]').text()).toContain(
      "origin/main is already part of",
    );
    expect(wrapper.get('[data-testid="status-hints"]').text()).toContain("commits");
    expect(useSettingsStore().values.compare?.b.label).toBe("origin/main");
    // ⌘1 leaves to the graph; the endpoints stay for the next launch.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    await settle();
    expect(wrapper.find('[data-testid="graph-focus"]').exists()).toBe(true);
    expect(useSettingsStore().values.compare).not.toBeNull();
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

  it("switches to the changes screen with Ctrl 3, keeps the sidebar, counts in the status bar", async () => {
    backend();
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", ctrlKey: true }));
    await settle();
    expect(shell.layoutMode).toBe("changes");
    expect(wrapper.find('[data-testid="changes-screen"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    // The same two files answer both diffs of the fake: two unstaged, two staged.
    expect(wrapper.get('[data-testid="status-changes"]').text()).toBe("2 unstaged, 2 staged");
    expect(wrapper.get('[data-testid="status-hints"]').text()).toContain("stage");
    expect(wrapper.get('[data-testid="status-hints"]').text()).toContain("Ctrl ↵");
    // The lists have the focus, so j moves the selected file.
    expect(document.activeElement?.getAttribute("data-path")).toBe("src/app.ts");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    await settle();
    expect(wrapper.get('[data-testid="changes-path"]').text()).toBe("pnpm-lock.yaml");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    await settle();
    expect(wrapper.find('[data-testid="graph-focus"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the operation banner and the conflicts list while a merge is stopped", async () => {
    backend({ conflict: "src/app.ts" });
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    const banner = wrapper.get('[data-testid="operation-banner"]');
    // The banner loads the commit context itself: the merge names its source on any screen.
    expect(banner.get('[data-testid="operation-title"]').text()).toBe(
      "Merging develop into main · 1 conflict",
    );
    await banner.get('[data-testid="operation-resolve"]').trigger("click");
    await settle();
    expect(shell.layoutMode).toBe("changes");
    const conflicts = wrapper.get('[data-testid="conflicts-list"]');
    const row = conflicts.get('[data-testid="tree-row"]');
    expect(row.text()).toContain("src/app.ts");
    expect(row.text()).toContain("both modified");
    expect(row.find('[data-status="unmerged"]').text()).toBe("U");
    expect(wrapper.get('[data-testid="status-stopped"]').text()).toBe(
      "Merge in progress · 1 conflict",
    );
    expect(wrapper.get('[data-testid="status-hints"]').text()).toContain("mark resolved");
    // The viewer offers "Mark resolved" on the conflicted file.
    await row.trigger("click");
    await settle();
    expect(wrapper.find('[data-testid="mark-resolved"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-action"]').exists()).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    await settle();
    expect(wrapper.find('[data-testid="operation-continue"]').attributes("disabled")).toBeDefined();
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
    const failedRow = wrapper.get('[data-testid="repo-list"] [data-testid="list-row"]');
    expect(failedRow.text()).toContain("not found");
    expect(failedRow.find('[data-testid="list-row-missing"]').exists()).toBe(true);
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

  it("shows the loading rows until the index answers, then the empty Home", async () => {
    backend({ emptyIndex: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="skeleton-row"]').length).toBeGreaterThan(0);
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe("Loading repositories…");
    await settle();
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(true);
    expect(wrapper.findAll("button").map((b) => b.text())).toEqual(
      expect.arrayContaining(["Open folder…", "Add a folder to scan"]),
    );
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

  it("scopes the graph once the branch selection settles, not on every j/k step", async () => {
    const wrapper = await openShell();
    const rows = wrapper.get('[data-testid="branch-list"]').findAll('[data-testid="list-row"]');
    (rows[0]?.element as HTMLElement).focus();
    await rows[0]!.trigger("keydown", { key: "j" });
    await rows[0]!.trigger("keydown", { key: "j" });
    // The second row is marked at once; the graph is still unscoped.
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false", "true"]);
    expect(useGraphStore().filters.scope.kind).toBe("all");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
    expect(useGraphStore().filters.scope).toEqual({
      kind: "ref",
      name: "origin/main",
      fullName: "refs/remotes/origin/main",
    });
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false", "true"]);
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
    // Folder names with the branch's lane dot and the tree icon.
    expect(rows.map((row) => row.text())).toEqual(["r", "claude-auth"]);
    expect(rows[0]?.find("[data-lane]").exists()).toBe(true);
    expect(rows[0]?.find("svg.lucide-list-tree").exists()).toBe(true);
    // The tab switched the main area to the dashboard.
    expect(useShellStore().layoutMode).toBe("worktrees");
    expect(wrapper.find('[data-testid="worktrees-layout"]').exists()).toBe(true);
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1"]);
    await rows[0]!.trigger("keydown", { key: "ArrowDown" });
    await rows[0]!.trigger("keydown", { key: "ArrowDown" });
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false", "true"]);
    expect(document.activeElement).toBe(rows[1]?.element);
    await rows[1]!.trigger("keydown", { key: "k" });
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("lists the index in the Repos tab, pinned first with worktrees under their repository, and opens with Enter", async () => {
    const wrapper = await openShell();
    await useIndexStore().load();
    await wrapper.get('[data-testid="tab-repos"]').trigger("click");
    const list = wrapper.get('[data-testid="repo-list"]');
    const rows = list.findAll('[data-testid="list-row"]');
    expect(rows.map((row) => row.text())).toEqual([
      "rmain",
      "claude-authclaude/fix-auth",
      "otherdevelop",
    ]);
    expect(rows[1]?.classes()).toContain("repo-list-nested");
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1", "-1"]);

    await wrapper.get('[data-testid="sidebar"] input').setValue("oth");
    const filtered = list.findAll('[data-testid="list-row"]');
    expect(filtered.map((row) => row.text())).toEqual(["otherdevelop"]);
    await wrapper.get('[data-testid="sidebar"] input').setValue("zzz");
    expect(list.text()).toContain("No repositories match the filter");
    await wrapper.get('[data-testid="sidebar"] input').setValue("");

    const again = list.findAll('[data-testid="list-row"]');
    (again[0]?.element as HTMLElement).focus();
    await again[0]!.trigger("keydown", { key: "j" });
    await again[1]!.trigger("keydown", { key: "j" });
    expect(again[2]?.attributes("aria-selected")).toBe("true");
    await again[2]!.trigger("keydown", { key: "Enter" });
    await settle();
    expect(useRepoStore().repo?.root).toBe("/other");
    wrapper.unmount();
  });

  it("opens a branch row's menu and checks the branch out from it, or with Enter", async () => {
    const wrapper = await openShell();
    const rows = wrapper.get('[data-testid="branch-list"]').findAll('[data-testid="list-row"]');
    await rows[1]!.trigger("contextmenu");
    await settle();
    const menu = wrapper.get('[role="menu"]');
    const labels = menu.findAll('[role="menuitem"]').map((item) => item.text());
    expect(labels[0]).toContain("Checkout");
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Create branch here…"),
        expect.stringContaining("Merge into main"),
        expect.stringContaining("Rebase main onto this"),
        expect.stringContaining("Compare with…"),
      ]),
    );
    // origin/main is a remote branch: no rename, upstream, push or delete.
    expect(menu.find('[data-testid="menu-rename"]').exists()).toBe(false);
    await menu.get('[data-testid="menu-checkout"]').trigger("click");
    await settle();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("branches.switched");
    // Enter on the current branch does nothing; the toast count stays.
    (rows[0]?.element as HTMLElement).focus();
    await rows[0]!.trigger("keydown", { key: "Enter" });
    await settle();
    expect(useToastsStore().toasts).toHaveLength(1);
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
    // One banner, in the diff panel; the file list stays.
    expect(wrapper.findAll('[data-testid="diff-failed"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="diff-failed"]').text()).toContain("took too long");
    expect(wrapper.find('[data-testid="review-error"]').exists()).toBe(false);
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

  it("counts files changed since their review and warns on their rows", async () => {
    backend({ staleMark: "src/app.ts" });
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    await shell.setLayoutMode("review");
    await settle();
    const rail = wrapper.get('[data-testid="review-rail"]');
    expect(rail.text()).toContain("0 of 1 files reviewed");
    expect(rail.get('[data-testid="review-changed"]').text()).toBe("1 changed since review");
    const row = wrapper.get('[data-path="src/app.ts"]');
    expect(row.get("svg.lucide-check").attributes("aria-label")).toBe("Changed since review");
    // Marking it again takes the content it shows now.
    useReviewStore().toggleReviewed("src/app.ts");
    await settle();
    expect(rail.text()).toContain("1 of 1 files reviewed");
    expect(rail.find('[data-testid="review-changed"]').exists()).toBe(false);
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
    await settle();
    await wrapper.get('[data-testid="home-open-folder"]').trigger("click");
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
