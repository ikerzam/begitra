import type { Channel } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitNode, IndexEntry, Project, Repo } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useGraphStore } from "@/stores/graph";
import { useIndexStore } from "@/stores/index";
import { useOperationsStore } from "@/stores/operations";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { useRemotesStore } from "@/stores/remotes";
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
      upstream: null,
      operation: null,
      fetchedAt: null,
      lastCommitSubject: null,
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

/** The project the fake backend lists: the repository under test, its worktree and another. */
const geoportal: Project = {
  id: 1,
  name: "Geoportal",
  kind: "list",
  folder: null,
  members: [
    { path: "/r", origin: "hand" },
    { path: "/wt/claude-auth", origin: "hand" },
    { path: "/other", origin: "hand" },
  ],
  pinned: false,
  openedAt: 1_700_000_500,
  lastRepository: "/r",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
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
    /** The project is the folder project of `/`, its repositories found by its scans. */
    folderProject?: boolean;
    /** The project holds the repository under test alone. */
    loneProject?: boolean;
    /** `open_repository` answers once this resolves. */
    openGate?: Promise<void>;
    /** `list_worktrees` answers once this resolves. */
    worktreesGate?: Promise<void>;
    /** `list_worktrees` rejects. */
    failWorktrees?: boolean;
  } = {},
) {
  const tip = options.tip ?? { index: 0 };
  const calls: string[] = [];
  /** The fake index: a project write drops entries and a gone folder is flagged on refresh. */
  let listed = options.emptyIndex ? [] : indexEntries.map((entry) => ({ ...entry }));
  const project: Project = options.folderProject
    ? {
        ...structuredClone(geoportal),
        kind: "folder",
        folder: "/",
        members: geoportal.members.map((member) => ({ ...member, origin: "folder" as const })),
      }
    : structuredClone(geoportal);
  if (options.loneProject) project.members = project.members.slice(0, 1);
  let projects: Project[] = options.emptyIndex ? [] : [project];
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
        if (options.openGate) {
          const path = args["path"] as string;
          return options.openGate.then(() => ({ ...repo, root: path, commonDir: `${path}/.git` }));
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
            committedAt: commit(tip.index).committer.time,
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
            committedAt: commit(tip.index).committer.time,
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
      case "projects":
        return projects;
      case "project_record_open":
        return true;
      case "project_for_path": {
        const path = args["path"] as string;
        const holder = projects.find((project) => project.members.some((m) => m.path === path));
        return { project: holder ?? geoportal, repository: path };
      }
      case "project_set_members": {
        const known = projects.find((project) => project.id === args["id"]);
        if (!known) return null;
        const paths = args["paths"] as string[];
        const changed = {
          ...known,
          members: paths.map((path) => ({ path, origin: "hand" as const })),
        };
        projects = projects.map((project) => (project.id === changed.id ? changed : project));
        const removed = known.members.map((m) => m.path).filter((path) => !paths.includes(path));
        listed = listed.filter((entry) => !removed.includes(entry.path));
        return { project: changed, removed };
      }
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
          head: "0".repeat(40),
          headParents: ["1".padStart(40, "0")],
          operation: options.conflict ? "merge" : "none",
          otherOperation: null,
          preparedMessage: options.conflict ? "Merge branch 'develop'" : null,
        };
      case "operation_state":
        return options.conflict ? "merge" : "none";
      case "conflicts":
        return options.conflict ? [{ path: options.conflict, kind: "both-modified" }] : [];
      case "mark_resolved":
      case "switch":
        return null;
      case "remotes":
        return [
          {
            name: "origin",
            fetchUrl: "https://x/r.git",
            pushUrl: "https://x/r.git",
            fetchedAt: null,
          },
        ];
      case "fetch":
      case "pull":
      case "push":
        send([{ kind: "done" }]);
        return null;
      case "list_worktrees": {
        if (options.failWorktrees) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          return Promise.reject({
            code: "git.cli_failed",
            message: "git worktree list failed",
            detail: "fatal: unable to read worktrees",
          });
        }
        const worktrees = [
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
            bare: false,
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
            bare: false,
          },
        ];
        return options.worktreesGate ? options.worktreesGate.then(() => worktrees) : worktrees;
      }
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
  it("offers Open folder… in the header, Add a folder of repositories in the centre, and emits", async () => {
    const wrapper = mountWithI18n(HomeEmpty);
    await wrapper.get('[data-testid="home-open-folder"]').trigger("click");
    await wrapper.get('[data-testid="home-empty-add"]').trigger("click");
    expect(wrapper.emitted("openFolder")).toHaveLength(1);
    expect(wrapper.emitted("addFolder")).toHaveLength(1);
    expect(wrapper.findAll("button")).toHaveLength(2);
    expect(wrapper.text()).toContain(
      "No projects yet. Open a repository or a folder of repositories, or add a folder that Begitra scans for them.",
    );
    expect(wrapper.text()).toContain("Open a repository, or a folder of repositories");
  });
});

describe("launch and the watcher", () => {
  it("reopens a project's Changes at launch when it was the last screen", async () => {
    await useSettingsStore().init(
      memoryStorage({ layoutMode: "changes", activeProject: 1 }),
      "windows",
    );
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(wrapper.find('[data-testid="project-view"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="project-title"]').text()).toBe("Geoportal");
    expect(useRepoStore().repo?.root).toBe("/r");
    wrapper.unmount();
  });

  it("turns the settings of a version before projects into the open project at launch", async () => {
    const storage = memoryStorage({ lastRepository: "/r", scanRoots: [] });
    await useSettingsStore().init(storage, "windows");
    const calls = backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(calls).toContain("project_for_path");
    expect(useSettingsStore().values.activeProject).toBe(1);
    expect(useRepoStore().repo?.root).toBe("/r");
    expect(storage.data.has("lastRepository")).toBe(false);
    wrapper.unmount();
  });

  it("reopens the open project's repository, watches it and refreshes on repo:changed", async () => {
    await useSettingsStore().init(memoryStorage({ activeProject: 1 }), "windows");
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
    // The working tree does not move the index entry: its dirty flag waits for the close.
    expect(calls.filter((c) => c === "refresh_repository")).toHaveLength(0);
    await emit("repo:changed", { repo: "/r", kinds: ["refs"], paths: [] });
    await settle();
    expect(calls.filter((c) => c === "list_refs")).toHaveLength(2);
    expect(calls.filter((c) => c === "refresh_repository")).toHaveLength(1);
    expect(useIndexStore().find("/r")?.summary.ahead).toBe(7);
    await emit("repo:changed", { repo: "/elsewhere", kinds: ["refs"], paths: [] });
    await settle();
    expect(calls.filter((c) => c === "list_refs")).toHaveLength(2);
    const worktreeListings = calls.filter((c) => c === "list_worktrees").length;
    await emit("repo:changed", { repo: "/r", kinds: ["worktrees"], paths: [] });
    await settle();
    expect(calls.filter((c) => c === "list_worktrees")).toHaveLength(worktreeListings + 1);
    // A worktree that came or went changes which branches are checked out where.
    expect(calls.filter((c) => c === "list_refs")).toHaveLength(3);
    expect(useProjectsStore().active?.lastRepository).toBe("/r");
    wrapper.unmount();
  });

  it("lists the history again when a tip moved outside the app, keeping the selection", async () => {
    await useSettingsStore().init(memoryStorage({ activeProject: 1 }), "windows");
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
    // The app's own write moved the tip and listed the history itself, with the refs: the event
    // that follows does not list it again.
    tip.index = 4;
    repo.reloadWalk(commit(2).hash);
    await settle();
    expect(walks()).toBe(3);
    await emit("repo:changed", { repo: "/r", kinds: ["refs"], paths: [] });
    await settle();
    expect(walks()).toBe(3);
    expect(repo.selectedCommit?.hash).toBe(commit(2).hash);
    // A terminal commit right after it is listed: no time window swallows it.
    tip.index = 5;
    await emit("repo:changed", { repo: "/r", kinds: ["refs"], paths: [] });
    await settle();
    expect(walks()).toBe(4);
    wrapper.unmount();
  });

  it("reopens on the worktrees dashboard when the app closed there", async () => {
    await useSettingsStore().init(
      memoryStorage({ activeProject: 1, layoutMode: "worktrees" }),
      "windows",
    );
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(useRepoStore().repo?.root).toBe("/r");
    expect(useShellStore().layoutMode).toBe("worktrees");
    expect(wrapper.find('[data-testid="worktrees-layout"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="sidebar-dashboard"]').attributes("aria-pressed")).toBe(
      "true",
    );
    // ⌘1 returns to the graph, the sidebar as it was.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    await settle();
    expect(useShellStore().layoutMode).toBe("graph");
    expect(wrapper.get('[data-testid="sidebar-dashboard"]').attributes("aria-pressed")).toBe(
      "false",
    );
    wrapper.unmount();
  });

  it("shows the error state inside the project when the repository it showed is gone", async () => {
    await useSettingsStore().init(memoryStorage({ activeProject: 1 }), "windows");
    backend({ failOpen: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(useRepoStore().state.kind).toBe("error");
    expect(useProjectsStore().active?.name).toBe("Geoportal");
    const banner = wrapper.get('[data-testid="graph-error"]');
    expect(banner.text()).toContain(
      "Couldn't open /r. The folder was removed or is no longer a Git repository.",
    );
    expect(banner.text()).toContain("Remove from project");
    // The Repositories section flags it among the project's repositories.
    const flagged = wrapper.get('[data-testid="repo-list"] [data-path="/r"]');
    expect(flagged.text()).toContain("not found");
    expect(useIndexStore().find("/r")?.missing).toBe(true);
    wrapper.unmount();
  });

  it("offers Scan again when a folder project's own repository is gone, which scans its folder", async () => {
    await useSettingsStore().init(memoryStorage({ activeProject: 1 }), "windows");
    const calls = backend({ failOpen: true, folderProject: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    const banner = wrapper.get('[data-testid="graph-error"]');
    // Only a scan of its folder takes one of its own repositories out of the project.
    expect(banner.text()).not.toContain("Remove from project");
    const scan = banner.findAll("button").find((button) => button.text() === "Scan again");
    await scan!.trigger("click");
    await settle();
    expect(calls).toContain("scan_folders");
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

  it("takes the repository out of its project from the error state, naming it first", async () => {
    await useSettingsStore().init(memoryStorage({ activeProject: 1 }), "windows");
    const calls = backend({ failOpen: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(useRepoStore().state.kind).toBe("error");
    await wrapper
      .get('[data-testid="graph-error"] button[data-variant="secondary"]')
      .trigger("click");
    await settle();
    // No other project holds /r: the confirmation names it before it leaves Begitra.
    expect(useProjectDialogsStore().removing).toBe("/r");
    const dialog = wrapper.get('[data-testid="remove-member-dialog"]');
    expect(dialog.text()).toContain("Remove r from Geoportal?");
    expect(dialog.get('[data-testid="leaving-list"]').text()).toContain("/r");
    expect(calls).not.toContain("project_set_members");
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settle();
    expect(calls).toContain("project_set_members");
    expect(useProjectsStore().active?.members.map((member) => member.path)).toEqual([
      "/wt/claude-auth",
      "/other",
    ]);
    expect(useIndexStore().find("/r")).toBeUndefined();
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
    expect(wrapper.get('[data-testid="branch-list-local"]').text()).toContain("main");
    expect(wrapper.get('[data-section="remote"] [data-testid="section-count"]').text()).toBe("1");
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

  it("fetches and pulls from the keyboard, and opens the push dialog on Ctrl Shift P", async () => {
    const calls = backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    useShellStore().setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    const press = (key: string) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true }));
    press("F");
    await settle();
    expect(calls.filter((cmd) => cmd === "fetch")).toHaveLength(1);
    press("L");
    await settle();
    expect(calls.filter((cmd) => cmd === "pull")).toHaveLength(1);
    // VS Code's palette key asks first: the dialog opens and nothing is pushed.
    press("P");
    await settle();
    expect(useRemotesStore().prompt).toEqual({ kind: "push", branch: "main" });
    expect(calls).not.toContain("push");
    // Behind the dialog, the fetch key does nothing.
    press("F");
    await settle();
    expect(calls.filter((cmd) => cmd === "fetch")).toHaveLength(1);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    expect(useRemotesStore().prompt).toBeNull();
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

  it("takes Ctrl F from the webview everywhere: the graph's search in graph focus, the find in review", async () => {
    backend();
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    const ctrlF = () => {
      const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(ctrlF()).toBe(true);
    await settle();
    const search = wrapper.get('[data-testid="graph-filters"] input').element;
    expect(document.activeElement).toBe(search);
    // Review focus opens the find bar on its field.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true }));
    await settle();
    expect(ctrlF()).toBe(true);
    await settle();
    const bar = wrapper.get('[data-testid="find-bar"]');
    expect(document.activeElement).toBe(bar.get("input").element);
    // The settings have no find: the key still never reaches the webview.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true }));
    await settle();
    expect(shell.layoutMode).toBe("settings");
    expect(ctrlF()).toBe(true);
    const f3 = new KeyboardEvent("keydown", { key: "F3", cancelable: true });
    window.dispatchEvent(f3);
    expect(f3.defaultPrevented).toBe(true);
    wrapper.unmount();
  });

  it("gives the graph's rows the focus when it comes back from another screen", async () => {
    backend();
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    const onRow = () => document.activeElement?.closest('[data-testid="graph-row"]') ?? null;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", ctrlKey: true }));
    await settle();
    expect(onRow()).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    await settle();
    expect(onRow()).not.toBeNull();
    // A file's "File history" from review focus lands on them too.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true }));
    await settle();
    expect(onRow()).toBeNull();
    await useGraphStore().showHistory("src/app.ts");
    await settle();
    expect(shell.layoutMode).toBe("graph");
    expect(onRow()).not.toBeNull();
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
    expect(row.get('[data-testid="tree-row-name"]').text()).toBe("app.ts");
    expect(row.get('[data-testid="tree-row-folder"]').text()).toBe("src");
    expect(row.text()).toContain("both modified");
    expect(row.find('[data-status="unmerged"]').text()).toBe("U");
    expect(row.get('[data-testid="tree-row-icon"]').classes()).toContain("lucide-file-code");
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

  it("resizes the sidebar from its divider, remembers it and resets it with a double click", async () => {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await useRepoStore().open("/r");
    await settle();
    const divider = wrapper.get('[aria-label="Resize the sidebar"]');
    await divider.trigger("mousedown", { clientX: 240 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 320 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await settle();
    expect(useSettingsStore().values.paneSizes.sidebar).toBe(320);
    expect(wrapper.get('[data-testid="sidebar"]').attributes("style")).toContain("width: 320px");
    await divider.trigger("dblclick");
    await settle();
    expect(useSettingsStore().values.paneSizes.sidebar).toBe(240);
    // Collapsed, the sidebar takes its divider with it.
    await useShellStore().toggleSidebar();
    await settle();
    expect(wrapper.find('[aria-label="Resize the sidebar"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the error state with the git output, and toggles the sidebar with Ctrl B", async () => {
    backend({ failOpen: true });
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await useRepoStore().open("/r");
    await settle();
    expect(wrapper.get('[data-testid="graph-error"]').text()).toContain(
      "Couldn't open /r. The folder was removed or is no longer a Git repository.",
    );
    expect(wrapper.get('[data-testid="detail-panel"]').text()).toContain(
      "Nothing to show until the repository opens",
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    await settle();
    expect(shell.sidebarCollapsed).toBe(true);
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sidebar-rail"]').exists()).toBe(true);
    // A rail icon shows the sidebar and hands the focus to the section it chose: its header,
    // since a repository that failed to open lists no branch.
    const railIcon = wrapper
      .get('[data-testid="sidebar-rail"]')
      .findAll("button")
      .find((button) => button.attributes("aria-label") === "Branches");
    await railIcon!.trigger("click");
    await settle();
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(document.activeElement).toBe(
      wrapper.get('[data-section="local"] [data-testid="section-header"]').element,
    );
    wrapper.unmount();
  });

  it("shows the loading rows until the index answers, then the empty Home", async () => {
    backend({ emptyIndex: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="skeleton-row"]').length).toBeGreaterThan(0);
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe("Loading projects…");
    await settle();
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(true);
    expect(wrapper.findAll("button").map((b) => b.text())).toEqual(
      expect.arrayContaining(["Open folder…", "Add a folder of repositories"]),
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
  const header = (wrapper: VueWrapper, id: string) =>
    wrapper.get(`[data-section="${id}"] [data-testid="section-header"]`);
  const count = (wrapper: VueWrapper, id: string) =>
    wrapper.get(`[data-section="${id}"] [data-testid="section-count"]`).text();

  async function openShell() {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    const projects = useProjectsStore();
    await settle();
    await projects.open(1);
    await settle();
    return wrapper;
  }

  it("shows the project's repositories, the branches and the worktrees, with the remote branches folded", async () => {
    const wrapper = await openShell();
    const sections = wrapper.findAll('[data-testid="sidebar-section"]');
    expect(sections.map((section) => section.attributes("data-section"))).toEqual([
      "repos",
      "local",
      "remote",
      "worktrees",
    ]);
    expect(["repos", "local", "remote", "worktrees"].map((id) => count(wrapper, id))).toEqual([
      "3",
      "1",
      "1",
      "2",
    ]);
    expect(
      ["repos", "local", "remote", "worktrees"].map((id) =>
        header(wrapper, id).attributes("aria-expanded"),
      ),
    ).toEqual(["true", "true", "false", "true"]);
    expect(wrapper.find('[data-testid="branch-list-remote"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("leaves no native tooltip in the shell: every hint is the app's", async () => {
    const wrapper = await openShell();
    await header(wrapper, "remote").trigger("click");
    await settle();
    expect(wrapper.findAll("[title], svg title")).toHaveLength(0);
    expect(wrapper.findAll("[data-tooltip]").length).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it("sorts the branches by their last commit or by name from the toggle in the Branches header", async () => {
    const wrapper = await openShell();
    const local = (name: string, committedAt: number) => ({
      name,
      fullName: `refs/heads/${name}`,
      kind: "local-branch" as const,
      target: commit(0).hash,
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt,
    });
    useRepoStore().refs = [local("alpha", 100), local("beta", 900), local("gamma", 500)];
    await settle();
    const names = () =>
      wrapper
        .get('[data-testid="branch-list-local"]')
        .findAll('[data-testid="list-row"]')
        .map((row) => row.text());
    expect(names()).toEqual(["beta", "gamma", "alpha"]);
    const toggle = wrapper.get('[data-testid="branch-sort"]');
    expect(toggle.attributes("aria-label")).toBe("Sort by name");
    await toggle.trigger("click");
    await settle();
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
    expect(useSettingsStore().values.branchSort).toBe("name");
    expect(wrapper.get('[data-testid="branch-sort"]').attributes("aria-label")).toBe(
      "Sort by last commit",
    );
    wrapper.unmount();
  });

  it("selects no branch on load, and j at a list's end goes on into the next open section", async () => {
    const wrapper = await openShell();
    const rows = wrapper
      .get('[data-testid="branch-list-local"]')
      .findAll('[data-testid="list-row"]');
    expect(rows.map((row) => row.text())).toEqual(["main20"]);
    expect(rows[0]?.attributes("aria-selected")).toBe("false");
    expect(wrapper.get('[data-testid="branch-list-local"]').attributes("tabindex")).toBeUndefined();
    expect(rows[0]?.attributes("tabindex")).toBe("0");
    (rows[0]?.element as HTMLElement).focus();
    await rows[0]!.trigger("keydown", { key: "j" });
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows[0]?.element);
    // The remote branches are folded: the next open section is the worktrees.
    await rows[0]!.trigger("keydown", { key: "j" });
    const worktrees = wrapper
      .get('[data-testid="worktree-list"]')
      .findAll('[data-testid="list-row"]');
    expect(worktrees[0]?.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(worktrees[0]?.element);
    // k at the worktrees' first row goes back to the last branch.
    await worktrees[0]!.trigger("keydown", { key: "k" });
    expect(document.activeElement).toBe(rows[0]?.element);
    wrapper.unmount();
  });

  it("scopes the graph once the branch selection settles, not on every j/k step", async () => {
    const wrapper = await openShell();
    await header(wrapper, "remote").trigger("click");
    await settle();
    const local = wrapper
      .get('[data-testid="branch-list-local"]')
      .findAll('[data-testid="list-row"]');
    const remote = wrapper
      .get('[data-testid="branch-list-remote"]')
      .findAll('[data-testid="list-row"]');
    (local[0]?.element as HTMLElement).focus();
    await local[0]!.trigger("keydown", { key: "j" });
    await local[0]!.trigger("keydown", { key: "j" });
    // The remote branch is marked at once; the graph is still unscoped.
    expect(local[0]?.attributes("aria-selected")).toBe("false");
    expect(remote[0]?.attributes("aria-selected")).toBe("true");
    expect(useGraphStore().filters.scope.kind).toBe("all");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
    expect(useGraphStore().filters.scope).toEqual({
      kind: "ref",
      name: "origin/main",
      fullName: "refs/remotes/origin/main",
    });
    expect(remote[0]?.attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("gives the repos and worktrees lists a tab stop and arrow navigation", async () => {
    const wrapper = await openShell();
    const repoRow = wrapper.get('[data-testid="repo-list"] [data-testid="list-row"]');
    expect(repoRow.attributes("tabindex")).toBe("0");
    expect(repoRow.attributes("aria-selected")).toBe("true");

    const rows = wrapper.get('[data-testid="worktree-list"]').findAll('[data-testid="list-row"]');
    // Folder names with the branch's lane dot and the tree icon.
    expect(rows.map((row) => row.text())).toEqual(["r", "claude-auth"]);
    expect(rows[0]?.find("[data-lane]").exists()).toBe(true);
    expect(rows[0]?.find("svg.lucide-list-tree").exists()).toBe(true);
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1"]);
    await rows[0]!.trigger("keydown", { key: "ArrowDown" });
    await rows[0]!.trigger("keydown", { key: "ArrowDown" });
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false", "true"]);
    expect(document.activeElement).toBe(rows[1]?.element);
    await rows[1]!.trigger("keydown", { key: "k" });
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    // A right click opens the worktree's menu, without the actions that ask in a dialog.
    await rows[1]!.trigger("contextmenu", { clientX: 20, clientY: 40 });
    const menu = wrapper.get('[role="menu"]');
    expect(menu.text()).toContain("Open in editor");
    expect(menu.find('[data-testid="menu-remove"]').exists()).toBe(false);
    expect(menu.find('[data-testid="menu-lock"]').exists()).toBe(false);
    // Escape closes it and the row takes the focus back, so the list keeps its keys.
    await menu.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(rows[1]?.element);
    wrapper.unmount();
  });

  it("lists the open project in the Repositories section, worktrees under their repository, and shows one with Enter", async () => {
    const wrapper = await openShell();
    await useIndexStore().load();
    await settle();
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
    expect(count(wrapper, "repos")).toBe("0 of 3");
    expect(wrapper.find('[data-testid="repo-list"]').exists()).toBe(false);
    await wrapper.get('[data-testid="sidebar"] input').setValue("");

    const again = wrapper.get('[data-testid="repo-list"]').findAll('[data-testid="list-row"]');
    (again[0]?.element as HTMLElement).focus();
    await again[0]!.trigger("keydown", { key: "j" });
    await again[1]!.trigger("keydown", { key: "j" });
    expect(again[2]?.attributes("aria-selected")).toBe("true");
    await again[2]!.trigger("keydown", { key: "Enter" });
    await settle();
    expect(useRepoStore().repo?.root).toBe("/other");
    wrapper.unmount();
  });

  it("opens a remote branch row's menu with the remote's actions, and Enter checks nothing out twice", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const wrapper = await openShell();
    await header(wrapper, "remote").trigger("click");
    await settle();
    const rows = [
      wrapper.get('[data-testid="branch-list-local"] [data-testid="list-row"]'),
      wrapper.get('[data-testid="branch-list-remote"] [data-testid="list-row"]'),
    ];
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
        expect.stringContaining("Pull into main"),
        expect.stringContaining("Fetch origin"),
        expect.stringContaining("Compare with…"),
        expect.stringContaining("Copy branch name"),
        expect.stringContaining("Delete on origin…"),
      ]),
    );
    // origin/main is a remote branch: no rename, upstream or push; its local branch, main, is
    // the current one, so there is nothing to check out.
    expect(menu.find('[data-testid="menu-rename"]').exists()).toBe(false);
    expect(menu.get('[data-testid="menu-checkout"]').attributes("aria-disabled")).toBe("true");
    await menu.get('[data-testid="menu-copy-name"]').trigger("click");
    await settle();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(writeText).toHaveBeenCalledWith("origin/main");
    expect(useToastsStore().toasts.at(-1)?.key).toBe("branches.nameCopied");
    // Enter on the current branch, or on the remote branch it tracks, does nothing.
    for (const row of [rows[0]!, rows[1]!]) {
      (row.element as HTMLElement).focus();
      await row.trigger("keydown", { key: "Enter" });
      await settle();
    }
    expect(useToastsStore().toasts).toHaveLength(1);
    wrapper.unmount();
  });

  it("folds and opens a section from its header, and remembers it", async () => {
    const wrapper = await openShell();
    expect(header(wrapper, "local").attributes("aria-expanded")).toBe("true");
    await header(wrapper, "local").trigger("click");
    await settle();
    expect(header(wrapper, "local").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find('[data-testid="branch-list-local"]').exists()).toBe(false);
    expect(useSettingsStore().values.sidebarFolded).toEqual(["remote", "tags", "local"]);
    await header(wrapper, "remote").trigger("click");
    await settle();
    expect(wrapper.find('[data-testid="branch-list-remote"]').exists()).toBe(true);
    expect(useSettingsStore().values.sidebarFolded).toEqual(["tags", "local"]);
    wrapper.unmount();
  });

  it("opens the sections the filter matches and folds the others, until it is cleared", async () => {
    const wrapper = await openShell();
    const filter = wrapper.get('[data-testid="sidebar"] input');
    await filter.setValue("origin");
    await settle();
    expect(header(wrapper, "remote").attributes("aria-expanded")).toBe("true");
    expect(count(wrapper, "remote")).toBe("1 of 1");
    expect(header(wrapper, "local").attributes("aria-expanded")).toBe("false");
    expect(count(wrapper, "local")).toBe("0 of 1");
    expect(header(wrapper, "worktrees").attributes("aria-expanded")).toBe("false");
    // A header pressed while filtering opens its section for the filter's time.
    await header(wrapper, "local").trigger("click");
    await settle();
    expect(header(wrapper, "local").attributes("aria-expanded")).toBe("true");
    await filter.setValue("");
    await settle();
    expect(header(wrapper, "remote").attributes("aria-expanded")).toBe("false");
    expect(header(wrapper, "local").attributes("aria-expanded")).toBe("true");
    expect(count(wrapper, "local")).toBe("1");
    expect(useSettingsStore().values.sidebarFolded).toEqual(["remote", "tags"]);
    wrapper.unmount();
  });

  it("reveals a section from the rail: opened, and its first row focused", async () => {
    const wrapper = await openShell();
    await header(wrapper, "worktrees").trigger("click");
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    await settle();
    await wrapper.get('[data-testid="rail-worktrees"]').trigger("click");
    await settle();
    expect(header(wrapper, "worktrees").attributes("aria-expanded")).toBe("true");
    const first = wrapper.get('[data-testid="worktree-list"] [data-testid="list-row"]');
    expect(document.activeElement).toBe(first.element);
    // The rail of a project of several repositories has the Repositories icon too.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    await settle();
    expect(
      wrapper.findAll('[data-testid="sidebar-rail"] button').map((b) => b.attributes("aria-label")),
    ).toEqual(["Repositories", "Branches", "Worktrees"]);
    wrapper.unmount();
  });

  it("opens and closes the worktrees dashboard from the Worktrees header", async () => {
    const wrapper = await openShell();
    const dashboard = wrapper.get('[data-testid="sidebar-dashboard"]');
    expect(dashboard.attributes("aria-label")).toBe("Show worktrees");
    await dashboard.trigger("click");
    await settle();
    expect(useShellStore().layoutMode).toBe("worktrees");
    expect(wrapper.get('[data-testid="sidebar-dashboard"]').attributes("aria-pressed")).toBe(
      "true",
    );
    await wrapper.get('[data-testid="sidebar-dashboard"]').trigger("click");
    await settle();
    expect(useShellStore().layoutMode).toBe("graph");
    wrapper.unmount();
  });

  it("keeps the keys of a worktree row's menu in the menu, on the list's first row too", async () => {
    const wrapper = await openShell();
    const rows = wrapper.get('[data-testid="worktree-list"]').findAll('[data-testid="list-row"]');
    await rows[0]!.trigger("contextmenu", { clientX: 20, clientY: 40 });
    await settle();
    const menu = wrapper.get('[role="menu"]');
    const item = menu.get('[role="menuitem"]');
    (item.element as HTMLElement).focus();
    for (const key of ["ArrowUp", "k"]) await item.trigger("keydown", { key });
    await settle();
    expect(menu.element.contains(document.activeElement)).toBe(true);
    const branch = wrapper.get('[data-testid="branch-list-local"] [data-testid="list-row"]');
    expect(branch.attributes("aria-selected")).toBe("false");
    wrapper.unmount();
  });

  it("counts the worktrees of a folded Worktrees section", async () => {
    backend();
    await useSettingsStore().update("sidebarFolded", ["remote", "tags", "worktrees"]);
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    await useProjectsStore().open(1);
    await settle();
    expect(header(wrapper, "worktrees").attributes("aria-expanded")).toBe("false");
    expect(count(wrapper, "worktrees")).toBe("2");
    wrapper.unmount();
  });

  it("shows skeleton rows while the repository opens and while its worktrees are read", async () => {
    let openRepository = () => {};
    let listWorktrees = () => {};
    backend({
      openGate: new Promise<void>((resolve) => (openRepository = resolve)),
      worktreesGate: new Promise<void>((resolve) => (listWorktrees = resolve)),
    });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    void useProjectsStore().open(1);
    await settle();
    const skeletons = (id: string) =>
      wrapper.findAll(`[data-section="${id}"] [data-testid="skeleton-row"]`).length;
    const counted = (id: string) =>
      wrapper.find(`[data-section="${id}"] [data-testid="section-count"]`).exists();
    expect(useRepoStore().state.kind).toBe("opening");
    expect([skeletons("local"), skeletons("worktrees")]).toEqual([6, 2]);
    // A section being read shows no count, rather than a 0 it does not mean.
    expect([counted("local"), counted("worktrees")]).toEqual([false, false]);
    expect(wrapper.get('[data-testid="sidebar"]').text()).not.toContain("No repository open");
    openRepository();
    await settle();
    expect([skeletons("local"), skeletons("worktrees")]).toEqual([0, 2]);
    expect([counted("local"), counted("worktrees")]).toEqual([true, false]);
    expect(wrapper.get('[data-testid="sidebar"]').text()).not.toContain("No linked worktrees");
    listWorktrees();
    await settle();
    expect(skeletons("worktrees")).toBe(0);
    expect(count(wrapper, "worktrees")).toBe("2");
    wrapper.unmount();
  });

  it("says when the worktrees cannot be listed, with git's output a click away", async () => {
    backend({ failWorktrees: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    await useProjectsStore().open(1);
    await settle();
    const error = wrapper.get('[data-section="worktrees"] [data-testid="worktrees-error"]');
    expect(error.text()).toContain("Couldn't list the worktrees.");
    await error.get('[data-testid="error-banner-toggle"]').trigger("click");
    expect(error.get('[data-testid="error-banner-output"]').text()).toBe(
      "fatal: unable to read worktrees",
    );
    expect(wrapper.get('[data-section="worktrees"]').text()).not.toContain("No linked worktrees");
    // The header says so in place of a count, and still does with the section folded.
    await header(wrapper, "worktrees").trigger("click");
    await settle();
    const alert = wrapper.get('[data-section="worktrees"] [data-testid="section-alert"]');
    expect(alert.attributes("aria-label")).toBe("Couldn't list the worktrees");
    expect(wrapper.find('[data-section="worktrees"] [data-testid="section-count"]').exists()).toBe(
      false,
    );
    wrapper.unmount();
  });

  it("keeps a section folded or opened by hand while the filter changes, and says what matches nothing", async () => {
    const wrapper = await openShell();
    const filter = wrapper.get('[data-testid="sidebar"] input');
    await filter.setValue("origin");
    await settle();
    await header(wrapper, "remote").trigger("click");
    await settle();
    expect(header(wrapper, "remote").attributes("aria-expanded")).toBe("false");
    for (const text of ["zzz", "origin/m"]) {
      await filter.setValue(text);
      await settle();
      expect(header(wrapper, "remote").attributes("aria-expanded")).toBe("false");
    }
    // The local branches, opened while nothing in them matches, say so.
    await header(wrapper, "local").trigger("click");
    await settle();
    expect(wrapper.get('[data-section="local"] [data-testid="section-no-matches"]').text()).toBe(
      "Nothing matches the filter.",
    );
    wrapper.unmount();
  });

  it("goes past an open section the filter leaves empty", async () => {
    const wrapper = await openShell();
    await useIndexStore().load();
    await settle();
    await wrapper.get('[data-testid="sidebar"] input').setValue("auth");
    await settle();
    await header(wrapper, "local").trigger("click");
    await settle();
    expect(header(wrapper, "local").attributes("aria-expanded")).toBe("true");
    const repoRow = wrapper.get('[data-testid="repo-list"] [data-testid="list-row"]');
    (repoRow.element as HTMLElement).focus();
    await repoRow.trigger("keydown", { key: "j" });
    await repoRow.trigger("keydown", { key: "j" });
    const worktree = wrapper.get('[data-testid="worktree-list"] [data-testid="list-row"]');
    expect(worktree.text()).toBe("claude-auth");
    expect(document.activeElement).toBe(worktree.element);
    wrapper.unmount();
  });

  it("leaves the focus on a section's header when a fold takes the focused row", async () => {
    const wrapper = await openShell();
    const row = wrapper.get('[data-testid="branch-list-local"] [data-testid="list-row"]');
    (row.element as HTMLElement).focus();
    await header(wrapper, "local").trigger("click");
    await settle();
    expect(document.activeElement).toBe(header(wrapper, "local").element);
    wrapper.unmount();
  });

  it("disables the rail at Home, where no sidebar shows, and opens the next project on its commits", async () => {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    const icons = wrapper.get('[data-testid="sidebar-rail"]').findAll("button");
    expect(icons.map((icon) => icon.attributes("disabled"))).toEqual(["", ""]);
    await icons[0]!.trigger("click");
    expect(useShellStore().sidebarReveal).toBeNull();
    await useProjectsStore().open(1);
    await settle();
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(document.activeElement?.closest('[data-testid="sidebar"]') ?? null).toBeNull();
    wrapper.unmount();
  });

  it("leaves the Repositories section and its rail icon out for a project of one", async () => {
    backend({ loneProject: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    await useProjectsStore().open(1);
    await settle();
    expect(
      wrapper.findAll('[data-testid="sidebar-section"]').map((s) => s.attributes("data-section")),
    ).toEqual(["local", "remote", "worktrees"]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    await settle();
    expect(
      wrapper.findAll('[data-testid="sidebar-rail"] button').map((b) => b.attributes("aria-label")),
    ).toEqual(["Branches", "Worktrees"]);
    wrapper.unmount();
  });

  it("leaves the focus on the Repositories section when a repository shown from it brings the dashboard back", async () => {
    const wrapper = await openShell();
    await useIndexStore().load();
    const toggle = wrapper.get('[data-testid="sidebar-dashboard"]');
    (toggle.element as HTMLElement).focus();
    await toggle.trigger("click");
    await settle();
    // The toggle hands the focus to the dashboard's rows.
    expect(document.activeElement?.closest('[data-testid="worktree-table"]')).not.toBeNull();
    const other = wrapper.get('[data-testid="repo-list"] [data-path="/other"]');
    (other.element as HTMLElement).focus();
    await other.trigger("keydown", { key: "Enter" });
    await settle();
    await settle();
    expect(useRepoStore().repo?.root).toBe("/other");
    expect(wrapper.find('[data-testid="worktrees-layout"]').exists()).toBe(true);
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="repo-list"] [data-path="/other"]').element,
    );
    wrapper.unmount();
  });

  it("disables the dashboard toggle while no repository is open", async () => {
    backend({ failOpen: true });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    await useProjectsStore().open(1);
    await settle();
    expect(useRepoStore().state.kind).toBe("error");
    expect(wrapper.get('[data-testid="sidebar-dashboard"]').attributes("disabled")).toBe("");
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
