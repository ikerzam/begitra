import type { Channel } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitNode, IndexEntry, Project, Ref, Repo } from "@/ipc/schemas";
import { useCompareStore } from "@/stores/compare";
import { usePickerStore } from "@/stores/picker";
import { ShortcutRegistry, setShortcutRegistry, shortcutRegistry } from "@/shortcuts/registry";
import { useGraphStore } from "@/stores/graph";
import { useIndexStore } from "@/stores/index";
import { useOperationsStore } from "@/stores/operations";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { memoryStorage, useSettingsStore, type CompareEndpoint } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useTabsStore } from "@/stores/tabs";
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
    /** This path conflicted with no operation in progress (a stash that came back). */
    stashConflict?: string;
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
    /** The repository has no remote branch. */
    noRemotes?: boolean;
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
        ].filter((ref) => !(options.noRemotes && ref.kind === "remote-branch"));
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
      case "conflicts": {
        const path = options.conflict ?? options.stashConflict;
        return path ? [{ path, kind: "both-modified" }] : [];
      }
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
    // The dashboard is a tab of its own, after the fixed ones.
    const names = () => wrapper.findAll('[data-testid="tab-name"]').map((name) => name.text());
    expect(names()).toEqual(["Graph", "Review", "Changes", "Overview", "Worktrees"]);
    // ⌘1 returns to the graph, the Worktrees tab staying in the row.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    await settle();
    expect(useShellStore().layoutMode).toBe("graph");
    expect(names()).toContain("Worktrees");
    // The Worktrees section's dashboard icon shows that tab again.
    await wrapper.get('[data-testid="rail-worktrees"]').trigger("click");
    await settle();
    await wrapper.get('[data-testid="sidebar-dashboard"]').trigger("click");
    await settle();
    expect(useShellStore().layoutMode).toBe("worktrees");
    expect(names()).toHaveLength(5);
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
    // The Repositories panel flags it among the project's repositories.
    await wrapper.get('[data-testid="rail-repos"]').trigger("click");
    await settle();
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
    expect(wrapper.find('[data-testid="sidebar-rail"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="graph-row"]')).toHaveLength(3);
    // Graph focus shows the Branches panel docked beside the rail.
    expect(wrapper.get('[data-testid="branch-list-local"]').text()).toContain("main");
    await wrapper.get('[data-testid="rail-remote"]').trigger("click");
    await settle();
    expect(wrapper.get('[data-testid="sidebar-panel-count"]').text()).toBe("1");
    await wrapper.get('[data-testid="rail-remote"]').trigger("click");
    await settle();
    expect(wrapper.find('[data-testid="sidebar-panel"]').exists()).toBe(false);
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
    expect(useTabsStore().activePair?.b.label).toBe("origin/main");
    // ⌘1 leaves for the graph in the project's tab; the comparison's tab stays in the row.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    await settle();
    expect(wrapper.find('[data-testid="graph-focus"]').exists()).toBe(true);
    expect(useTabsStore().comparisons).toHaveLength(1);
    // A repository open outside a project keeps its comparison in the session, in the row.
    expect(wrapper.get('[data-testid="tab-row"]').text()).toContain("origin/main");
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
    expect(wrapper.find('[data-testid="sidebar-rail"]').exists()).toBe(true);
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

  it("counts the conflicts no operation holds in the status bar", async () => {
    backend({ stashConflict: "src/app.ts" });
    const shell = useShellStore();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    shell.setWindowWidth(1440);
    await useRepoStore().open("/r");
    await settle();
    await shell.setLayoutMode("changes");
    await settle();
    expect(wrapper.get('[data-testid="status-stopped"]').text()).toBe("1 conflict");
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

  it("resizes a panel from its edge, remembers it for every panel and resets it with a double click", async () => {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await useRepoStore().open("/r");
    await settle();
    // Graph focus shows the panel, with its edge.
    const divider = wrapper.get('[aria-label="Resize the sidebar"]');
    await divider.trigger("mousedown", { clientX: 288 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 368 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await settle();
    expect(useSettingsStore().values.paneSizes.sidebar).toBe(320);
    expect(wrapper.get('[data-testid="sidebar-panel"]').attributes("style")).toContain(
      "width: 320px",
    );
    // Another section shows at the same width.
    await wrapper.get('[data-testid="rail-worktrees"]').trigger("click");
    await settle();
    expect(wrapper.get('[data-testid="sidebar-panel"]').attributes("style")).toContain(
      "width: 320px",
    );
    await wrapper.get('[aria-label="Resize the sidebar"]').trigger("dblclick");
    await settle();
    expect(useSettingsStore().values.paneSizes.sidebar).toBe(240);
    // Closed, the panel takes its edge with it.
    await wrapper.get('[data-testid="rail-worktrees"]').trigger("click");
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
    expect(wrapper.find('[data-testid="sidebar-rail"]').exists()).toBe(true);
    // The Branches panel shows beside the rail; a repository that failed to open lists no branch.
    expect(wrapper.get('[data-testid="sidebar-panel"]').text()).toContain("No repository open");
    // Ctrl B closes it, and opens it again on its filter, its list having no row.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    await settle();
    expect(wrapper.find('[data-testid="sidebar-panel"]').exists()).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    await settle();
    expect(shell.sidebarSection).toBe("local");
    const panel = wrapper.get('[data-testid="sidebar-panel"]');
    expect(document.activeElement).toBe(panel.get('[data-testid="sidebar-filter"]').element);
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

describe("Sidebar rail and panel", () => {
  const rail = (wrapper: VueWrapper) =>
    wrapper.findAll('[data-testid="sidebar-rail"] button').map((b) => b.attributes("aria-label"));
  const icon = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-testid="rail-${id}"]`);
  const panel = (wrapper: VueWrapper) => wrapper.find('[data-testid="sidebar-panel"]');
  const count = (wrapper: VueWrapper) => wrapper.get('[data-testid="sidebar-panel-count"]').text();
  const inRows = (wrapper: VueWrapper) =>
    wrapper.get('[data-testid="commit-rows"]').element.contains(document.activeElement);

  let calls: string[] = [];

  async function openShell(options: Parameters<typeof backend>[0] = {}) {
    calls = backend(options);
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    await useProjectsStore().open(1);
    await settle();
    return wrapper;
  }

  /** Shows section `id` in the panel: a click on its icon, unless the panel shows it already. */
  async function show(wrapper: VueWrapper, id: string) {
    const shown = panel(wrapper);
    if (!shown.exists() || shown.attributes("data-panel") !== id) {
      await icon(wrapper, id).trigger("click");
      await settle();
    }
    return wrapper.get('[data-testid="sidebar-panel"]');
  }

  const press = (key: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, ...init }));

  it("shows the rail where the tab acts on the repository, and none in the Overview, the settings or at Home", async () => {
    const wrapper = await openShell();
    const icons = ["Repositories", "Branches", "Remote branches", "Tags", "Worktrees"];
    expect(rail(wrapper)).toEqual(icons);
    // Graph focus shows the Branches panel; review focus the rail alone.
    expect(panel(wrapper).attributes("data-panel")).toBe("local");
    press("2");
    await settle();
    expect(rail(wrapper)).toEqual(icons);
    expect(panel(wrapper).exists()).toBe(false);
    // The folder view of a project of several, the Overview and the settings have no sidebar.
    for (const key of ["3", "4", ","]) {
      press(key);
      await settle();
      expect(wrapper.find('[data-testid="sidebar-rail"]').exists()).toBe(false);
      expect(panel(wrapper).exists()).toBe(false);
    }
    press("1");
    await settle();
    expect(panel(wrapper).attributes("data-panel")).toBe("local");
    await useProjectsStore().close();
    await settle();
    expect(wrapper.find('[data-testid="sidebar-rail"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("docks the panel beside the rail, its list focused when an icon shows it; the icon or Ctrl B closes it", async () => {
    const wrapper = await openShell();
    const docked = panel(wrapper);
    expect(wrapper.get('[data-testid="sidebar-rail"]').element.nextElementSibling).toBe(
      docked.element,
    );
    expect(docked.classes()).not.toContain("absolute");
    expect(docked.get('[data-testid="sidebar-panel-title"]').text()).toBe("Branches");
    expect(count(wrapper)).toBe("1");
    // A toggle: the icon of the section shown is pressed while the panel is open.
    expect(icon(wrapper, "local").attributes("aria-pressed")).toBe("true");
    expect(icon(wrapper, "local").attributes("aria-expanded")).toBeUndefined();
    const shown = await show(wrapper, "remote");
    expect(shown.attributes("data-panel")).toBe("remote");
    expect(icon(wrapper, "local").attributes("aria-pressed")).toBe("false");
    const row = shown.get('[data-testid="branch-list-remote"] [data-testid="list-row"]');
    expect(document.activeElement).toBe(row.element);
    // The layout beside it is still graph focus.
    expect(wrapper.find('[data-testid="graph-focus"]').exists()).toBe(true);
    // Its icon closes it.
    await icon(wrapper, "remote").trigger("click");
    await settle();
    expect(panel(wrapper).exists()).toBe(false);
    expect(icon(wrapper, "remote").attributes("aria-pressed")).toBe("false");
    // Ctrl B opens it on the section it showed, its list focused, and closes it from there,
    // the graph's rows taking the focus.
    press("b");
    await settle();
    expect(panel(wrapper).attributes("data-panel")).toBe("remote");
    expect(panel(wrapper).element.contains(document.activeElement)).toBe(true);
    press("b");
    await settle();
    expect(panel(wrapper).exists()).toBe(false);
    expect(inRows(wrapper)).toBe(true);
    wrapper.unmount();
  });

  it("hands the focus to the comparison and the dashboard on Escape too", async () => {
    const wrapper = await openShell();
    useCompareStore().open(
      { kind: "revision", rev: "refs/heads/main", label: "main" },
      { kind: "revision", rev: "refs/remotes/origin/main", label: "origin/main" },
    );
    await settle();
    let shown = await show(wrapper, "local");
    let row = shown.get('[data-testid="branch-list-local"] [data-testid="list-row"]');
    (row.element as HTMLElement).focus();
    await row.trigger("keydown", { key: "Escape" });
    await settle();
    expect(
      wrapper.get('[data-testid="compare-layout"]').element.contains(document.activeElement),
    ).toBe(true);
    press(",");
    await settle();
    await useShellStore().setLayoutMode("worktrees");
    await settle();
    shown = await show(wrapper, "local");
    row = shown.get('[data-testid="branch-list-local"] [data-testid="list-row"]');
    (row.element as HTMLElement).focus();
    await row.trigger("keydown", { key: "Escape" });
    await settle();
    expect(
      wrapper.get('[data-testid="worktrees-layout"]').element.contains(document.activeElement),
    ).toBe(true);
    wrapper.unmount();
  });

  it("gives the dashboard's rows the focus when its icon shows it", async () => {
    const wrapper = await openShell();
    await show(wrapper, "worktrees");
    const dashboard = wrapper.get('[data-testid="sidebar-dashboard"]');
    (dashboard.element as HTMLElement).focus();
    await dashboard.trigger("click");
    await settle();
    expect(
      wrapper.get('[data-testid="worktrees-layout"]').element.contains(document.activeElement),
    ).toBe(true);
    wrapper.unmount();
  });

  it("keeps the focus on the worktree list when Enter opens a worktree as the context", async () => {
    const wrapper = await openShell();
    const shown = await show(wrapper, "worktrees");
    const rows = shown.findAll('[data-testid="worktree-list"] [data-testid="list-row"]');
    // The worktree open already lists nothing again, and holds nothing.
    const own = rows.find((row) => row.text() === "r")!;
    (own.element as HTMLElement).focus();
    await own.trigger("keydown", { key: "Enter" });
    await settle();
    expect(useShellStore().sidebarFocusHeld).toBe(false);
    expect(document.activeElement).toBe(own.element);
    const auth = rows.find((row) => row.text() === "claude-auth")!;
    (auth.element as HTMLElement).focus();
    await auth.trigger("keydown", { key: "Enter" });
    await settle();
    expect(useRepoStore().repo?.root).toBe("/wt/claude-auth");
    expect(useShellStore().sidebarFocusHeld).toBe(false);
    expect(
      wrapper.get('[data-testid="worktree-list"]').element.contains(document.activeElement),
    ).toBe(true);
    wrapper.unmount();
  });

  it("hands the focus to the layout on Escape and stays open, a press on the graph reaching it", async () => {
    const wrapper = await openShell();
    const shown = await show(wrapper, "worktrees");
    const row = shown.get('[data-testid="worktree-list"] [data-testid="list-row"]');
    (row.element as HTMLElement).focus();
    await row.trigger("keydown", { key: "Escape" });
    await settle();
    expect(panel(wrapper).exists()).toBe(true);
    expect(inRows(wrapper)).toBe(true);
    // A press on the graph selects the commit it pressed, the panel staying.
    const commitRow = wrapper.findAll('[data-testid="graph-row"]')[2]!;
    commitRow.element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await commitRow.trigger("click");
    await settle();
    expect(panel(wrapper).exists()).toBe(true);
    expect(useRepoStore().selectedIndex).toBe(2);
    wrapper.unmount();
  });

  it("keeps the panel open through a row's menu and the dialog its action opens", async () => {
    const wrapper = await openShell();
    const shown = await show(wrapper, "local");
    const row = shown.get('[data-testid="branch-list-local"] [data-testid="list-row"]');
    await row.trigger("contextmenu", { clientX: 40, clientY: 80 });
    await settle();
    const rename = wrapper.get('[role="menu"] [data-testid="menu-rename"]');
    rename.element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await rename.trigger("click");
    await settle();
    const dialog = wrapper.get('[role="dialog"]');
    const field = dialog.get("input");
    field.element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await settle();
    expect(panel(wrapper).exists()).toBe(true);
    // Escape in the dialog closes the dialog alone.
    await field.trigger("keydown", { key: "Escape" });
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(panel(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps a filter per section while another shows, and clears them for another repository", async () => {
    const wrapper = await openShell();
    await useIndexStore().load();
    let shown = await show(wrapper, "local");
    await shown.get('[data-testid="sidebar-filter"]').setValue("zzz");
    await settle();
    expect(count(wrapper)).toBe("0 of 1");
    expect(shown.get('[data-testid="panel-no-matches"]').text()).toBe(
      "Nothing matches the filter.",
    );
    shown = await show(wrapper, "remote");
    expect((shown.get('[data-testid="sidebar-filter"]').element as HTMLInputElement).value).toBe(
      "",
    );
    expect(count(wrapper)).toBe("1");
    shown = await show(wrapper, "local");
    expect((shown.get('[data-testid="sidebar-filter"]').element as HTMLInputElement).value).toBe(
      "zzz",
    );
    await useProjectsStore().show("/other");
    await settle();
    shown = await show(wrapper, "worktrees");
    shown = await show(wrapper, "local");
    expect((shown.get('[data-testid="sidebar-filter"]').element as HTMLInputElement).value).toBe(
      "",
    );
    wrapper.unmount();
  });

  it("sorts the branches by their last commit or by name from the Branches panel's header", async () => {
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
    await show(wrapper, "local");
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
    // ↵ on a branch checks it out, the panel staying open.
    const beta = wrapper.findAll('[data-testid="branch-list-local"] [data-testid="list-row"]')[1]!;
    await beta.trigger("click");
    await beta.trigger("keydown", { key: "Enter" });
    await settle();
    expect(calls).toContain("switch");
    expect(panel(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it("marks a branch another worktree holds and one whose upstream is gone", async () => {
    const wrapper = await openShell();
    const local = (name: string, over: Partial<Ref> = {}): Ref => ({
      name,
      fullName: `refs/heads/${name}`,
      kind: "local-branch",
      target: commit(0).hash,
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: 100,
      ...over,
    });
    const shownRows = async (section = "local") => {
      await settle();
      const shown = await show(wrapper, section);
      const rows = shown.findAll(`[data-testid="branch-list-${section}"] [data-testid="list-row"]`);
      return (name: string) =>
        rows.find((row) => row.get('[data-testid="list-row-name"]').text() === name)!;
    };
    useRepoStore().refs = [
      local("main", {
        isCurrent: true,
        worktree: "/r",
        upstream: "origin/main",
        ahead: 2,
        behind: 0,
        committedAt: 900,
      }),
      local("claude/fix-auth", { worktree: "/wt/claude-auth", committedAt: 800 }),
      local("feature/old-tiles", { upstream: "origin/feature/old-tiles", committedAt: 700 }),
      local("feature/local-only", { committedAt: 600 }),
      local("claude/gone-too", {
        worktree: "/wt/claude-gone",
        upstream: "origin/claude/gone-too",
        committedAt: 500,
      }),
      {
        ...local("origin/main", { committedAt: 900 }),
        fullName: "refs/remotes/origin/main",
        kind: "remote-branch",
      },
      { ...local("v2.3.1", { committedAt: 400 }), fullName: "refs/tags/v2.3.1", kind: "tag" },
    ];
    let row = await shownRows();
    // An agent's branch: the tree in its dot's lane colour after it, said in the tooltip and read
    // with the row; its name whole in its own tooltip.
    const held = row("claude/fix-auth");
    const icon = held.get('[data-testid="list-row-icon"]');
    const lane = held.get("[data-lane]").attributes("data-lane");
    expect(icon.classes()).toContain(`text-lane-${lane}`);
    expect(icon.attributes("data-tooltip")).toBe("Checked out in claude-auth");
    expect(held.attributes("aria-description")).toBe("Checked out in claude-auth");
    expect(held.get('[data-testid="list-row-name"]').attributes("data-tooltip")).toBe(
      "claude/fix-auth",
    );
    // A gone upstream: "gone" where the counts would be.
    const gone = row("feature/old-tiles");
    const meta = gone.get('[data-testid="list-row-meta"]');
    expect(meta.text()).toBe("gone");
    expect(meta.attributes("data-tooltip")).toBe(
      "origin/feature/old-tiles is gone from its remote",
    );
    expect(gone.find('[data-testid="ahead"]').exists()).toBe(false);
    expect(gone.attributes("aria-description")).toBe(
      "origin/feature/old-tiles is gone from its remote",
    );
    // Both on one row: both sentences.
    expect(row("claude/gone-too").attributes("aria-description")).toBe(
      "Checked out in claude-gone. origin/claude/gone-too is gone from its remote",
    );
    // The current branch, with its counts, and a branch without upstream show neither.
    for (const name of ["main", "feature/local-only"]) {
      expect(row(name).find('[data-testid="list-row-icon"]').exists()).toBe(false);
      expect(row(name).find('[data-testid="list-row-meta"]').exists()).toBe(false);
      expect(row(name).attributes("aria-description")).toBeUndefined();
    }
    expect(row("main").find('[data-testid="ahead"]').text()).toBe("2");
    // Remote branches and tags are never marked.
    const remote = await shownRows("remote");
    expect(remote("origin/main").find('[data-testid="list-row-meta"]').exists()).toBe(false);
    expect(remote("origin/main").attributes("aria-description")).toBeUndefined();
    const tags = await shownRows("tags");
    expect(tags("v2.3.1").get('[data-testid="list-row-icon"]').attributes("data-tooltip")).toBe(
      undefined,
    );
    expect(tags("v2.3.1").attributes("aria-description")).toBeUndefined();
    // From a linked worktree, the main worktree's branch is the one held elsewhere; the current
    // branch whose upstream is gone says so.
    useRepoStore().refs = [
      local("main", { worktree: "/r", committedAt: 900 }),
      local("claude/fix-auth", {
        isCurrent: true,
        worktree: "/wt/claude-auth",
        upstream: "origin/claude/fix-auth",
        committedAt: 800,
      }),
    ];
    row = await shownRows();
    expect(row("main").get('[data-testid="list-row-icon"]').attributes("data-tooltip")).toBe(
      "Checked out in r",
    );
    const current = row("claude/fix-auth");
    expect(current.find('[data-testid="list-row-icon"]').exists()).toBe(false);
    expect(current.get('[data-testid="list-row-meta"]').text()).toBe("gone");
    wrapper.unmount();
  });

  it("selects no branch on open, and scopes the graph once the selection settles", async () => {
    const wrapper = await openShell();
    const shown = await show(wrapper, "remote");
    const rows = shown.findAll('[data-testid="branch-list-remote"] [data-testid="list-row"]');
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["false"]);
    expect(rows[0]?.attributes("tabindex")).toBe("0");
    await rows[0]!.trigger("keydown", { key: "j" });
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    expect(useGraphStore().filters.scope.kind).toBe("all");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
    expect(useGraphStore().filters.scope).toEqual({
      kind: "ref",
      name: "origin/main",
      fullName: "refs/remotes/origin/main",
    });
    expect(panel(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it("lists the project's repositories in their section, worktrees under their repository, and shows one with Enter", async () => {
    const wrapper = await openShell();
    await useIndexStore().load();
    await settle();
    const shown = await show(wrapper, "repos");
    const list = shown.get('[data-testid="repo-list"]');
    const rows = list.findAll('[data-testid="list-row"]');
    expect(rows.map((row) => row.text())).toEqual([
      "rmain",
      "claude-authclaude/fix-auth",
      "otherdevelop",
    ]);
    expect(rows[1]?.classes()).toContain("repo-list-nested");
    expect(rows.map((row) => row.attributes("aria-selected"))).toEqual(["true", "false", "false"]);
    await shown.get('[data-testid="sidebar-filter"]').setValue("oth");
    expect(list.findAll('[data-testid="list-row"]').map((row) => row.text())).toEqual([
      "otherdevelop",
    ]);
    await shown.get('[data-testid="sidebar-filter"]').setValue("");
    const again = wrapper.get('[data-testid="repo-list"]').findAll('[data-testid="list-row"]');
    (again[0]?.element as HTMLElement).focus();
    await again[0]!.trigger("keydown", { key: "j" });
    await again[1]!.trigger("keydown", { key: "j" });
    expect(again[2]?.attributes("aria-selected")).toBe("true");
    await again[2]!.trigger("keydown", { key: "Enter" });
    await settle();
    expect(useRepoStore().repo?.root).toBe("/other");
    expect(panel(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it("opens a remote branch row's menu with the remote's actions", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const wrapper = await openShell();
    const shown = await show(wrapper, "remote");
    const row = shown.get('[data-testid="branch-list-remote"] [data-testid="list-row"]');
    await row.trigger("contextmenu");
    await settle();
    const menu = wrapper.get('[role="menu"]');
    const labels = menu.findAll('[role="menuitem"]').map((item) => item.text());
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Pull into main"),
        expect.stringContaining("Fetch origin"),
        expect.stringContaining("Delete on origin…"),
      ]),
    );
    expect(menu.find('[data-testid="menu-rename"]').exists()).toBe(false);
    expect(menu.get('[data-testid="menu-checkout"]').attributes("aria-disabled")).toBe("true");
    await menu.get('[data-testid="menu-copy-name"]').trigger("click");
    await settle();
    expect(writeText).toHaveBeenCalledWith("origin/main");
    expect(panel(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the worktrees dashboard's tab from the Worktrees section", async () => {
    const wrapper = await openShell();
    await show(wrapper, "worktrees");
    const dashboard = wrapper.get('[data-testid="sidebar-dashboard"]');
    expect(dashboard.attributes("aria-label")).toBe("Show worktrees");
    expect(dashboard.attributes("aria-pressed")).toBeUndefined();
    await dashboard.trigger("click");
    await settle();
    expect(useShellStore().layoutMode).toBe("worktrees");
    // The dashboard's tab keeps the panel beside it, open as the dashboard's tabs have it.
    expect(panel(wrapper).attributes("data-panel")).toBe("worktrees");
    press("1");
    await settle();
    expect(useShellStore().layoutMode).toBe("graph");
    wrapper.unmount();
  });

  it("lists the worktrees with their lane dots, and keeps a row menu's keys in the menu", async () => {
    const wrapper = await openShell();
    const shown = await show(wrapper, "worktrees");
    const rows = shown.get('[data-testid="worktree-list"]').findAll('[data-testid="list-row"]');
    expect(rows.map((row) => row.text())).toEqual(["r", "claude-auth"]);
    expect(rows[0]?.find("[data-lane]").exists()).toBe(true);
    expect(rows[0]?.find("svg.lucide-list-tree").exists()).toBe(true);
    await rows[0]!.trigger("contextmenu", { clientX: 20, clientY: 40 });
    await settle();
    const menu = wrapper.get('[role="menu"]');
    expect(menu.text()).toContain("Open in editor");
    expect(menu.find('[data-testid="menu-remove"]').exists()).toBe(false);
    const item = menu.get('[role="menuitem"]');
    (item.element as HTMLElement).focus();
    for (const key of ["ArrowUp", "k"]) await item.trigger("keydown", { key });
    await settle();
    expect(menu.element.contains(document.activeElement)).toBe(true);
    // Escape closes the menu alone, its row taking the focus back.
    await menu.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(panel(wrapper).exists()).toBe(true);
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
    expect(useRepoStore().state.kind).toBe("opening");
    const skeletons = () =>
      wrapper.findAll('[data-testid="sidebar-panel"] [data-testid="skeleton-row"]');
    await show(wrapper, "local");
    expect(skeletons()).toHaveLength(6);
    // A section being read shows no count, rather than a 0 it does not mean.
    expect(count(wrapper)).toBe("");
    await show(wrapper, "worktrees");
    expect(skeletons()).toHaveLength(2);
    openRepository();
    await settle();
    expect(skeletons()).toHaveLength(2);
    expect(count(wrapper)).toBe("");
    listWorktrees();
    await settle();
    expect(skeletons()).toHaveLength(0);
    expect(count(wrapper)).toBe("2");
    wrapper.unmount();
  });

  it("says when the worktrees cannot be listed, with git's output a click away and the alert on the rail", async () => {
    const wrapper = await openShell({ failWorktrees: true });
    expect(wrapper.find('[data-testid="rail-worktrees-alert"]').exists()).toBe(true);
    expect(icon(wrapper, "worktrees").attributes("data-tooltip")).toBe(
      "Couldn't list the worktrees",
    );
    // Read out after the icon's name too, which the dot alone does not say.
    expect(icon(wrapper, "worktrees").attributes("aria-description")).toBe(
      "Couldn't list the worktrees",
    );
    const shown = await show(wrapper, "worktrees");
    const error = shown.get('[data-testid="worktrees-error"]');
    expect(error.text()).toContain("Couldn't list the worktrees.");
    await error.get('[data-testid="error-banner-toggle"]').trigger("click");
    expect(error.get('[data-testid="error-banner-output"]').text()).toBe(
      "fatal: unable to read worktrees",
    );
    expect(shown.text()).not.toContain("No linked worktrees");
    expect(count(wrapper)).toBe("");
    wrapper.unmount();
  });

  it("leaves the Repositories icon out for a project of one", async () => {
    const wrapper = await openShell({ loneProject: true });
    expect(rail(wrapper)).toEqual(["Branches", "Remote branches", "Tags", "Worktrees"]);
    wrapper.unmount();
  });

  it("follows its rail in the tab order, before the layout, and stays as the focus moves on", async () => {
    const wrapper = await openShell();
    const shown = await show(wrapper, "local");
    expect(wrapper.get('[data-testid="sidebar-rail"]').element.nextElementSibling).toBe(
      shown.element,
    );
    expect(shown.element.nextElementSibling?.id).toBe("tab-panel");
    const row = shown.get('[data-testid="branch-list-local"] [data-testid="list-row"]');
    (row.element as HTMLElement).focus();
    const commitRow = wrapper.findAll('[data-testid="graph-row"]')[1]!.element as HTMLElement;
    commitRow.focus();
    await settle();
    expect(panel(wrapper).exists()).toBe(true);
    expect(document.activeElement).toBe(commitRow);
    wrapper.unmount();
  });

  it("leaves the focus where it is when Ctrl B acts from the layout", async () => {
    const wrapper = await openShell();
    const second = wrapper.findAll('[data-testid="graph-row"]')[1]!.element as HTMLElement;
    second.focus();
    press("b");
    await settle();
    expect(panel(wrapper).exists()).toBe(false);
    expect(document.activeElement).toBe(second);
    wrapper.unmount();
  });

  it("shows skeleton rows in every ref section while the repository opens, then says when there is none", async () => {
    let openRepository = () => {};
    backend({
      openGate: new Promise<void>((resolve) => (openRepository = resolve)),
      noRemotes: true,
    });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    void useProjectsStore().open(1);
    await settle();
    const skeletons = () =>
      wrapper.findAll('[data-testid="sidebar-panel"] [data-testid="skeleton-row"]');
    await show(wrapper, "remote");
    expect(skeletons()).toHaveLength(6);
    await show(wrapper, "tags");
    expect(skeletons()).toHaveLength(6);
    openRepository();
    await settle();
    expect(skeletons()).toHaveLength(0);
    expect(wrapper.get('[data-testid="branch-list-empty"]').text()).toBe("No tags");
    await show(wrapper, "remote");
    expect(wrapper.get('[data-testid="branch-list-empty"]').text()).toBe("No remote branches");
    wrapper.unmount();
  });

  it("says no repository is open in a ref section of one that failed, whose dashboard cannot open", async () => {
    const wrapper = await openShell({ failOpen: true });
    await show(wrapper, "tags");
    expect(wrapper.get('[data-testid="branch-list-empty"]').text()).toBe("No repository open");
    await show(wrapper, "worktrees");
    expect(wrapper.get('[data-testid="sidebar-dashboard"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("keeps the panel when a press on a dialog's backdrop closes the dialog", async () => {
    const wrapper = await openShell();
    const shown = await show(wrapper, "local");
    const row = shown.get('[data-testid="branch-list-local"] [data-testid="list-row"]');
    await row.trigger("contextmenu", { clientX: 40, clientY: 80 });
    await settle();
    await wrapper.get('[role="menu"] [data-testid="menu-rename"]').trigger("click");
    await settle();
    const scrim = wrapper.get('[role="dialog"]').element.closest("[data-scrim]")!;
    scrim.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(panel(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it("does nothing with Ctrl B behind the palette or at Home, and opens the next project as its graph has it", async () => {
    const wrapper = await openShell();
    press("k");
    await settle();
    press("b");
    await settle();
    expect(panel(wrapper).exists()).toBe(true);
    expect(wrapper.find('[data-testid="palette-overlay"]').exists()).toBe(true);
    useShellStore().closePalette();
    await useProjectsStore().close();
    await settle();
    press("b");
    shortcutRegistry().run("toggle-sidebar");
    await settle();
    expect(useShellStore().sidebarOpen).toBe(false);
    expect(useSettingsStore().values.sidebarPanels.graph).toBe(true);
    // The palette offers no toggle at Home.
    press("k");
    await settle();
    await wrapper.get('[data-testid="palette-input"]').setValue("sidebar panel");
    expect(wrapper.findAll('[data-testid="palette-row"]')).toHaveLength(0);
    useShellStore().closePalette();
    await useProjectsStore().open(1);
    await settle();
    expect(panel(wrapper).attributes("data-panel")).toBe("local");
    wrapper.unmount();
  });

  it("shows Branches in place of Repositories once the project holds a single repository", async () => {
    const wrapper = await openShell();
    await show(wrapper, "repos");
    const projects = useProjectsStore();
    await projects.setMembers(1, [projects.activeMembers[0]!.path]);
    await settle();
    expect(rail(wrapper)).not.toContain("Repositories");
    expect(panel(wrapper).attributes("data-panel")).toBe("local");
    wrapper.unmount();
  });

  it("opens beside review focus, closed there until the user opens it, and keeps each tab's", async () => {
    const wrapper = await openShell();
    press("2");
    await settle();
    expect(panel(wrapper).exists()).toBe(false);
    await show(wrapper, "local");
    expect(wrapper.find('[data-testid="review-focus"]').exists()).toBe(true);
    // Graph focus closes its own; review focus keeps its own open.
    press("1");
    await settle();
    press("b");
    await settle();
    expect(panel(wrapper).exists()).toBe(false);
    press("2");
    await settle();
    expect(panel(wrapper).exists()).toBe(true);
    press("1");
    await settle();
    expect(panel(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps the layout's single keys from acting while the panel's list has the focus", async () => {
    const wrapper = await openShell();
    press("2");
    await settle();
    const review = useReviewStore();
    const shown = await show(wrapper, "local");
    const row = shown.get('[data-testid="branch-list-local"] [data-testid="list-row"]');
    (row.element as HTMLElement).focus();
    await row.trigger("keydown", { key: "r" });
    await settle();
    expect(review.reviewedFiles.size).toBe(0);
    wrapper.unmount();
  });

  it("scopes the graph to a branch chosen just before the panel closed", async () => {
    const wrapper = await openShell();
    const shown = await show(wrapper, "remote");
    const row = shown.get('[data-testid="branch-list-remote"] [data-testid="list-row"]');
    await row.trigger("keydown", { key: "j" });
    press("b");
    await settle();
    expect(panel(wrapper).exists()).toBe(false);
    expect(useGraphStore().filters.scope).toEqual({
      kind: "ref",
      name: "origin/main",
      fullName: "refs/remotes/origin/main",
    });
    wrapper.unmount();
  });

  it("leaves no native tooltip in the shell: every hint is the app's", async () => {
    const wrapper = await openShell();
    await show(wrapper, "local");
    expect(wrapper.findAll("[title], svg title")).toHaveLength(0);
    expect(wrapper.findAll("[data-tooltip]").length).toBeGreaterThan(0);
    wrapper.unmount();
  });
});

describe("Tabs", () => {
  const main: CompareEndpoint = { kind: "revision", rev: "refs/heads/main", label: "main" };
  const upstream: CompareEndpoint = {
    kind: "revision",
    rev: "refs/remotes/origin/main",
    label: "origin/main",
  };
  const older: CompareEndpoint = { kind: "revision", rev: commit(2).hash, label: "c2" };
  /** Geoportal holds three repositories: its fixed tabs, the Overview among them. */
  const fixed = ["Graph", "Review", "Changes", "Overview"];

  async function openShell() {
    const calls = backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    await useProjectsStore().open(1);
    await settle();
    return { wrapper, calls };
  }

  async function compare(a: CompareEndpoint, b: CompareEndpoint) {
    useCompareStore().open(a, b);
    await settle();
  }

  const row = (wrapper: VueWrapper) => wrapper.find('[data-testid="tab-row"]');
  const names = (wrapper: VueWrapper) =>
    wrapper.findAll('[data-testid="tab-name"]').map((name) => name.text());
  const tabs = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="tab"]');
  const shown = (wrapper: VueWrapper) =>
    tabs(wrapper).findIndex((tab) => tab.attributes("aria-selected") === "true");
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true, ...init });
    window.dispatchEvent(event);
    return event;
  };

  it("shows a project's fixed tabs in a row, and a comparison's tab after them", async () => {
    const { wrapper } = await openShell();
    expect(names(wrapper)).toEqual(fixed);
    expect(shown(wrapper)).toBe(0);
    // The fixed tabs never close, and name the key that shows them.
    expect(wrapper.findAll('[data-testid="tab-close"]')).toHaveLength(0);
    expect(tabs(wrapper).map((tab) => tab.attributes("data-tooltip-keys"))).toEqual([
      "Ctrl 1",
      "Ctrl 2",
      "Ctrl 3",
      "Ctrl 4",
    ]);
    // The top bar holds no toggle of them.
    expect(wrapper.find('[data-testid="mode-graph"]').exists()).toBe(false);
    await compare(main, upstream);
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main"]);
    expect(shown(wrapper)).toBe(4);
    expect(wrapper.find('[data-testid="compare-layout"]').exists()).toBe(true);
    // The whole name is the tab's tooltip, whatever the row cuts.
    expect(tabs(wrapper)[4]?.attributes("data-tooltip")).toBe("main ↔ origin/main");
    expect(tabs(wrapper)[4]?.find('[data-testid="tab-close"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("comes back to a comparison after ⌘1, recomputed, and the Graph tab as it was", async () => {
    const { wrapper, calls } = await openShell();
    useRepoStore().select(1);
    await compare(main, upstream);
    const compared = calls.filter((cmd) => cmd === "compare").length;
    press("1");
    await settle();
    expect(wrapper.find('[data-testid="graph-focus"]').exists()).toBe(true);
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main"]);
    expect(shown(wrapper)).toBe(0);
    expect(useRepoStore().selectedIndex).toBe(1);
    await tabs(wrapper)[4]!.trigger("click");
    await settle();
    expect(wrapper.find('[data-testid="compare-layout"]').exists()).toBe(true);
    expect(calls.filter((cmd) => cmd === "compare")).toHaveLength(compared + 1);
    // The Graph tab shows the commit it had selected.
    await tabs(wrapper)[0]!.trigger("click");
    await settle();
    expect(wrapper.find('[data-testid="graph-focus"]').exists()).toBe(true);
    expect(useRepoStore().selectedIndex).toBe(1);
    wrapper.unmount();
  });

  it("goes round the row with Ctrl Tab, and back with Ctrl Shift Tab", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    await compare(main, older);
    await tabs(wrapper)[0]!.trigger("click");
    await settle();
    // Each opens after the tab shown: the second after the first.
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main", "main ↔ c2"]);
    const seen: number[] = [];
    for (let step = 0; step < 6; step += 1) {
      press("Tab");
      await settle();
      seen.push(shown(wrapper));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 0]);
    press("Tab", { shiftKey: true });
    await settle();
    expect(shown(wrapper)).toBe(5);
    // The palette names the key.
    expect(shortcutRegistry().hint("next-tab")).toBe("Ctrl Tab");
    wrapper.unmount();
  });

  it("gives a comparison's first list the focus when its tab shows, once its rows arrive", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    await compare(main, older);
    press("4");
    await settle();
    const inSideA = () => document.activeElement?.closest('[data-testid="side-main"]') != null;
    press("Tab");
    await settle();
    expect(shown(wrapper)).toBe(4);
    expect(inSideA()).toBe(true);
    // To the next comparison: the layout stays and its lists load again.
    press("Tab");
    await settle();
    expect(shown(wrapper)).toBe(5);
    expect(inSideA()).toBe(true);
    wrapper.unmount();
  });

  it("closes the tab shown with Ctrl W, the tab before it showing; a fixed tab never", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    await compare(main, older);
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main", "main ↔ c2"]);
    press("w");
    await settle();
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main"]);
    expect(shown(wrapper)).toBe(4);
    press("w");
    await settle();
    expect(names(wrapper)).toEqual(fixed);
    expect(wrapper.find('[data-testid="project-view"]').exists()).toBe(true);
    // On a fixed tab the key closes nothing, and never reaches the webview.
    const event = press("w");
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(names(wrapper)).toEqual(fixed);
    wrapper.unmount();
  });

  it("closes a tab from its close control and with a middle click, without showing it", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    await compare(main, older);
    await tabs(wrapper)[4]!.get('[data-testid="tab-close"]').trigger("click");
    await settle();
    expect(names(wrapper)).toEqual([...fixed, "main ↔ c2"]);
    expect(shown(wrapper)).toBe(4);
    await tabs(wrapper)[4]!.trigger("auxclick", { button: 1 });
    await settle();
    expect(names(wrapper)).toEqual(fixed);
    wrapper.unmount();
  });

  it("does nothing with the tabs' keys behind the palette", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    press("k");
    await settle();
    press("Tab");
    press("w");
    await settle();
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main"]);
    expect(shown(wrapper)).toBe(4);
    wrapper.unmount();
  });

  it("keeps review focus on its own target while a comparison shows", async () => {
    const { wrapper } = await openShell();
    const review = useReviewStore();
    review.setTarget({ kind: "commit", hash: commit(1).hash });
    press("2");
    await settle();
    await compare(main, upstream);
    expect(review.target).toEqual({
      kind: "range",
      from: main.rev,
      to: upstream.rev,
      threeDot: true,
    });
    press("2");
    await settle();
    expect(wrapper.find('[data-testid="review-focus"]').exists()).toBe(true);
    expect(review.target).toEqual({ kind: "commit", hash: commit(1).hash });
    expect(shown(wrapper)).toBe(1);
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main"]);
    wrapper.unmount();
  });

  it("shows a fixed tab from a click, the comparison's tab staying", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    await tabs(wrapper)[2]!.trigger("click");
    await settle();
    expect(useShellStore().layoutMode).toBe("changes");
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main"]);
    expect(shown(wrapper)).toBe(2);
    wrapper.unmount();
  });

  it("opens the settings' tab after the fixed tabs from the gear, which shows pressed", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    await tabs(wrapper)[0]!.trigger("click");
    await settle();
    await wrapper.get('[data-testid="mode-settings"]').trigger("click");
    await settle();
    expect(names(wrapper)).toEqual([...fixed, "Settings", "main ↔ origin/main"]);
    expect(shown(wrapper)).toBe(4);
    expect(wrapper.find('[data-testid="settings-layout"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="mode-settings"]').attributes("aria-pressed")).toBe("true");
    // The settings show without the sidebar.
    expect(wrapper.find('[data-testid="sidebar-rail"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows Home's tab alone at Home, and the settings' tab beside it from the gear", async () => {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(row(wrapper).exists()).toBe(false);
    await wrapper.get('[data-testid="mode-settings"]').trigger("click");
    await settle();
    expect(names(wrapper)).toEqual(["Projects", "Settings"]);
    expect(shown(wrapper)).toBe(1);
    expect(wrapper.find('[data-testid="settings-layout"]').exists()).toBe(true);
    press("w");
    await settle();
    expect(row(wrapper).exists()).toBe(false);
    expect(wrapper.find('[data-testid="home-screen"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("renames a tab when its sides swap, and shows an open pair's tab rather than another", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    useCompareStore().swap();
    await settle();
    expect(names(wrapper)).toEqual([...fixed, "origin/main ↔ main"]);
    press("1");
    await settle();
    await compare(upstream, main);
    expect(names(wrapper)).toEqual([...fixed, "origin/main ↔ main"]);
    expect(shown(wrapper)).toBe(4);
    wrapper.unmount();
  });

  it("changes the comparison of its own tab from an endpoint control, and opens another from Compare with", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    const picker = usePickerStore();
    picker.open({ kind: "compare", side: "b", other: main, inTab: true });
    await picker.choose({ kind: "revision", rev: older.rev, label: "c2" });
    await settle();
    expect(names(wrapper)).toEqual([...fixed, "main ↔ c2"]);
    picker.open({ kind: "compare", side: "b", other: main });
    await picker.choose({ kind: "revision", rev: upstream.rev, label: "origin/main" });
    await settle();
    expect(names(wrapper)).toEqual([...fixed, "main ↔ c2", "main ↔ origin/main"]);
    expect(shown(wrapper)).toBe(5);
    wrapper.unmount();
  });

  it("moves the focus with the tab shown while the row holds it, whatever shows the tab", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    await compare(main, older);
    (tabs(wrapper)[5]!.element as HTMLElement).focus();
    press("Tab");
    await settle();
    expect(shown(wrapper)).toBe(0);
    expect(document.activeElement).toBe(tabs(wrapper)[0]?.element);
    press("2");
    await settle();
    expect(shown(wrapper)).toBe(1);
    expect(document.activeElement).toBe(tabs(wrapper)[1]?.element);
    wrapper.unmount();
  });

  it("labels the layout below as the panel of the tab shown", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    const panel = wrapper.get("#tab-panel");
    const active = tabs(wrapper)[4]!;
    expect(panel.attributes("role")).toBe("tabpanel");
    expect(panel.attributes("aria-labelledby")).toBe(active.attributes("id"));
    expect(active.attributes("aria-controls")).toBe("tab-panel");
    expect(tabs(wrapper)[0]?.attributes("aria-controls")).toBeUndefined();
    expect(active.attributes("aria-description")).toBe("Ctrl W closes it");
    // What a tooltip adds is read too: a fixed tab's key, the Settings tab's and its close.
    expect(tabs(wrapper)[0]?.attributes("aria-description")).toBe("Ctrl 1");
    press(",");
    await settle();
    expect(tabs(wrapper)[shown(wrapper)]?.attributes("aria-description")).toBe(
      "Ctrl ,; Ctrl W closes it",
    );
    // The layouts paint in their own stacking context, under the sidebar panel's menus.
    expect(panel.classes()).toContain("isolate");
    wrapper.unmount();
  });

  it("gives Home's list the focus when Home's tab shows again", async () => {
    backend();
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    await wrapper.get('[data-testid="mode-settings"]').trigger("click");
    await settle();
    press("w");
    await settle();
    expect(wrapper.find('[data-testid="home-screen"]').exists()).toBe(true);
    expect(
      wrapper.get('[data-testid="home-screen"]').element.contains(document.activeElement),
    ).toBe(true);
    wrapper.unmount();
  });

  it("sets a commit's short hash in mono in its tab's name", async () => {
    const { wrapper } = await openShell();
    await compare({ kind: "revision", rev: commit(2).hash, label: "c2c2c2c" }, main);
    const parts = tabs(wrapper)[4]!.findAll('[data-testid="tab-name"] > span');
    expect(parts.map((part) => [part.text(), part.classes().includes("font-mono")])).toEqual([
      ["c2c2c2c", true],
      ["↔", false],
      ["main", false],
    ]);
    wrapper.unmount();
  });

  it("shows a comparison's tab as the comparison loading while its repository opens", async () => {
    let openRepository = () => {};
    backend({ openGate: new Promise<void>((resolve) => (openRepository = resolve)) });
    const settings = useSettingsStore();
    await settings.update("activeProject", 1);
    await settings.update("tabs", {
      "1": { open: [{ kind: "compare", a: main, b: upstream }], active: 0 },
    });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(useRepoStore().state.kind).toBe("opening");
    expect(wrapper.find('[data-testid="compare-layout"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="graph-focus"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="merge-preview-loading"]').exists()).toBe(true);
    openRepository();
    await settle();
    expect(wrapper.find('[data-testid="merge-preview-up-to-date"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("moves between the tabs with the arrows on the row, which keeps the focus", async () => {
    const { wrapper } = await openShell();
    await compare(main, upstream);
    const active = tabs(wrapper)[4]!;
    expect(active.attributes("tabindex")).toBe("0");
    expect(tabs(wrapper)[0]?.attributes("tabindex")).toBe("-1");
    (active.element as HTMLElement).focus();
    await active.trigger("keydown", { key: "ArrowLeft" });
    await settle();
    expect(shown(wrapper)).toBe(3);
    expect(document.activeElement).toBe(tabs(wrapper)[3]?.element);
    await tabs(wrapper)[3]!.trigger("keydown", { key: "ArrowRight" });
    await settle();
    expect(shown(wrapper)).toBe(4);
    await tabs(wrapper)[4]!.trigger("keydown", { key: "ArrowRight" });
    await settle();
    expect(shown(wrapper)).toBe(0);
    expect(document.activeElement).toBe(tabs(wrapper)[0]?.element);
    wrapper.unmount();
  });

  it("reopens on the comparison's tab the window was closed on", async () => {
    backend();
    const settings = useSettingsStore();
    await settings.update("activeProject", 1);
    await settings.update("tabs", {
      "1": { open: [{ kind: "compare", a: main, b: upstream }], active: 0 },
    });
    const wrapper = mountWithI18n(AppShell, { attachTo: document.body });
    await settle();
    expect(wrapper.find('[data-testid="compare-layout"]').exists()).toBe(true);
    expect(names(wrapper)).toEqual([...fixed, "main ↔ origin/main"]);
    expect(shown(wrapper)).toBe(4);
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
