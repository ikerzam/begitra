import { emit } from "@tauri-apps/api/event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IndexEntry } from "@/ipc/schemas";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { changedFile } from "@/test/changes";

import { pathUnder, useFolderStore } from "./folder";
import { useIndexStore } from "./index";
import { useChangesStore } from "./changes";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";
import { useShellStore } from "./shell";

const CODE = "/code";

function entry(name: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path: `${CODE}/${name}`,
    name,
    kind: "main",
    parentPath: null,
    scanRoot: CODE,
    summary: {
      currentBranch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      lastCommitAt: 1_704_000_000,
      upstream: null,
      operation: null,
      fetchedAt: null,
      dirty: false,
    },
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: 1_704_000_100,
    missing: false,
    ...over,
  };
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

async function openFolder(options: FakeBackendOptions = {}) {
  const calls = fakeBackend({
    mockEvents: true,
    repositories: [
      entry("web", { summary: { ...entry("web").summary, currentBranch: "feat/tiles" } }),
      entry("api"),
      entry("infra"),
      entry("gone", { missing: true }),
      entry("other", { path: "/elsewhere/other", scanRoot: "/elsewhere" }),
    ],
    changesByRepo: {
      "/code/api": { unstaged: [changedFile("src/a.ts"), changedFile("src/b.ts")], staged: [] },
      "/code/web": { unstaged: [], staged: [changedFile("tiles.ts")] },
      "/code/infra": { unstaged: [], staged: [] },
    },
    ...options,
  });
  await useIndexStore().load();
  const folder = useFolderStore();
  await folder.open(CODE);
  folder.show();
  for (let i = 0; i < 4; i += 1) await settled();
  return { folder, calls };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  useFolderStore().hide();
  clearMocks();
});

describe("pathUnder", () => {
  it("names a path by where it is under the folder", () => {
    expect(pathUnder("/code", "/code/api")).toBe("api");
    expect(pathUnder("C:\\Code\\", "C:\\code\\wt\\feat")).toBe("wt/feat");
    expect(pathUnder("/code", "/elsewhere/x")).toBe("/elsewhere/x");
  });
});

describe("useFolderStore", () => {
  it("lists the folder's repositories with changes as sections and the others in the group", async () => {
    const { folder, calls } = await openFolder();
    expect(useShellStore().layoutMode).toBe("folder");
    expect(useSettingsStore().values.folderView).toBe(CODE);
    expect(folder.sections.map((repository) => repository.name)).toEqual(["api", "web"]);
    expect(folder.sections[1]?.branch).toBe("feat/tiles");
    expect(folder.clean.map((repository) => repository.name)).toEqual(["infra"]);
    expect(folder.state).toBe("changes");
    expect(folder.active?.root).toBe("/code/api");
    // Each repository's lists come from its own diffs; a missing entry and another folder's
    // repository are left out.
    expect(new Set(of(calls, "diff").map((call) => call.args["repo"]))).toEqual(
      new Set(["/code/api", "/code/infra", "/code/web"]),
    );
    expect(of(calls, "watch_folder").at(-1)?.args).toEqual({
      roots: ["/code/api", "/code/infra", "/code/web"],
    });
  });

  it("reads two repositories at a time", async () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const calls = fakeBackend({
      repositories: names.map((name) => entry(name)),
      diffDelayMs: 40,
    });
    await useIndexStore().load();
    const folder = useFolderStore();
    await folder.open(CODE);
    folder.show();
    await settled();
    // Two lists a repository.
    expect(of(calls, "diff")).toHaveLength(4);
    expect(folder.state).toBe("loading");
    expect(folder.checking).toHaveLength(6);
    await vi.waitFor(() => expect(of(calls, "diff")).toHaveLength(12), { timeout: 2000 });
  });

  it("closes the engine of a repository once its lists are read, but the active one's and the open one's", async () => {
    fakeBackend({ rootIsPath: true });
    await useRepoStore().open("/code/infra");
    const { folder, calls } = await openFolder();
    // The closes of this folder's repositories (a model of an earlier test may end late).
    const ours = new Set(["/code/api", "/code/infra", "/code/web"]);
    const closed = () =>
      of(calls, "close_repository")
        .map((call) => call.args["root"])
        .filter((root) => typeof root === "string" && ours.has(root));
    // api holds the selection, infra is the open repository: web alone lets its engine go.
    expect(folder.active?.root).toBe("/code/api");
    await vi.waitFor(() => expect(closed()).toEqual(["/code/web"]));
    // The selection moves to web: api's engine goes once it is left.
    folder.activate("/code/web");
    await vi.waitFor(() => expect(closed()).toEqual(["/code/web", "/code/api"]));
    // A change read in a repository the selection is not in lets its engine go again.
    await emit("repo:changed", { repo: "/code/api", kinds: ["status"], paths: ["src/a.ts"] });
    await vi.waitFor(() => expect(closed()).toEqual(["/code/web", "/code/api", "/code/api"]), {
      timeout: 3000,
    });
    expect(closed()).not.toContain("/code/infra");
  });

  it("follows the changes each repository's watcher names, and nothing of other folders", async () => {
    const { calls } = await openFolder();
    const before = of(calls, "diff_paths").length;
    await emit("repo:changed", { repo: "/code/web", kinds: ["status"], paths: ["tiles.ts"] });
    await emit("repo:changed", { repo: "/elsewhere/other", kinds: ["status"], paths: ["x"] });
    await settled();
    const reads = of(calls, "diff_paths").slice(before);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.args).toMatchObject({ repo: "/code/web", paths: ["tiles.ts"] });
  });

  it("commits the box's repository, which leaves the sections once it is clean", async () => {
    const { folder, calls } = await openFolder();
    folder.activate("/code/web");
    const web = folder.active;
    expect(web?.name).toBe("web");
    web?.view.setDraft({ subject: "fix: tiles" });
    expect(await web?.view.commit()).toBe(true);
    for (let i = 0; i < 3; i += 1) await settled();
    expect(of(calls, "commit").at(-1)?.args).toMatchObject({ repo: "/code/web" });
    expect(folder.sections.map((repository) => repository.name)).toEqual(["api"]);
    expect(folder.clean.map((repository) => repository.name)).toEqual(["infra", "web"]);
    // The selection is gone with its section: the box goes back to the first section.
    expect(folder.active?.root).toBe("/code/api");
    expect(folder.active?.view.draft.subject).toBe("");
  });

  it("reads everything again on the window's focus, at most every five seconds", async () => {
    const { calls } = await openFolder();
    const before = of(calls, "diff").length;
    window.dispatchEvent(new Event("focus"));
    await settled();
    expect(of(calls, "diff").length - before).toBe(6);
    window.dispatchEvent(new Event("focus"));
    await settled();
    expect(of(calls, "diff").length - before).toBe(6);
  });

  it("stops its watchers and closes the engines it opened when it leaves", async () => {
    fakeBackend({});
    await useRepoStore().open("/r");
    const { folder, calls } = await openFolder();
    const closedBefore = of(calls, "close_repository").length;
    folder.hide();
    await settled();
    expect(of(calls, "unwatch_folder")).toHaveLength(1);
    // The open repository, /r, is not the folder's: every engine the view opened closes.
    expect(
      of(calls, "close_repository")
        .slice(closedBefore)
        .map((call) => call.args["root"]),
    ).toEqual(["/code/api", "/code/infra", "/code/web"]);
    // Events after leaving reach nothing.
    const before = of(calls, "diff_paths").length;
    await emit("repo:changed", { repo: "/code/web", kinds: ["status"], paths: ["tiles.ts"] });
    await settled();
    expect(of(calls, "diff_paths")).toHaveLength(before);
  });

  it("reads the repositories again two at a time when the view comes back", async () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const calls = fakeBackend({ repositories: names.map((name) => entry(name)), diffDelayMs: 40 });
    await useIndexStore().load();
    const folder = useFolderStore();
    await folder.open(CODE);
    folder.show();
    await vi.waitFor(() => expect(folder.checking).toHaveLength(0), { timeout: 2000 });
    const before = of(calls, "diff").length;
    folder.hide();
    folder.show();
    await settled();
    // Two repositories, two lists each; the others wait their turn.
    expect(of(calls, "diff").length - before).toBe(4);
  });

  it("closes the engines of the folder it leaves for another", async () => {
    const { folder, calls } = await openFolder();
    const before = of(calls, "close_repository").length;
    await folder.open("/nothing");
    await vi.waitFor(() => {
      const closed = of(calls, "close_repository")
        .slice(before)
        .map((call) => call.args["root"]);
      expect(new Set(closed)).toEqual(new Set(["/code/api", "/code/infra", "/code/web"]));
    });
  });

  it("gives the box of the repository the selection is in its context", async () => {
    const { folder, calls } = await openFolder();
    const asked = () => of(calls, "commit_context").map((call) => call.args["repo"]);
    await vi.waitFor(() => expect(folder.active?.view.context?.author).toBe("Iker Z. <iker@x>"));
    expect(asked()).toEqual(["/code/api"]);
    folder.activate("/code/web");
    await vi.waitFor(() => expect(asked()).toEqual(["/code/api", "/code/web"]));
  });

  it("follows a branch switched in a repository of the view", async () => {
    const { folder, calls } = await openFolder({
      summaries: { "/code/web": { ...entry("web").summary, currentBranch: "main" } },
    });
    await emit("repo:changed", { repo: "/code/web", kinds: ["refs"], paths: [] });
    await vi.waitFor(() =>
      expect(of(calls, "refresh_repository").map((call) => call.args["path"])).toContain(
        "/code/web",
      ),
    );
    await vi.waitFor(() =>
      expect(folder.sections.find((section) => section.root === "/code/web")?.branch).toBe("main"),
    );
  });

  it("shares the open repository's lists and draft with the changes screen", async () => {
    fakeBackend({ rootIsPath: true });
    await useRepoStore().open("/code/web");
    const { folder } = await openFolder();
    const web = folder.repositories.find((repository) => repository.root === "/code/web");
    expect(web?.view).toBe(useChangesStore());
    useChangesStore().setDraft({ subject: "fix: tiles" });
    expect(web?.view.draft.subject).toBe("fix: tiles");
  });

  it("waits for the index, and names its failure", async () => {
    fakeBackend({ failIndex: true });
    const folder = useFolderStore();
    await folder.open(CODE);
    folder.show();
    expect(folder.state).toBe("scanning");
    await useIndexStore().load();
    expect(folder.state).toBe("error");
    expect(folder.problem?.kind).toBe("index");
  });

  it("scans a folder again as a scan folder of Home when it was removed", async () => {
    const calls = fakeBackend({});
    await useIndexStore().load();
    const folder = useFolderStore();
    await folder.open("/gone");
    folder.scanAgain();
    await settled();
    expect(useSettingsStore().values.scanRoots).toContain("/gone");
    expect(of(calls, "scan_folders").at(-1)?.args["folders"]).toEqual(["/gone"]);
  });

  it("shows the scan looking, then an empty folder with no repository", async () => {
    fakeBackend({});
    await useIndexStore().load();
    const folder = useFolderStore();
    await folder.open("/empty");
    folder.show();
    await settled();
    expect(folder.state).toBe("empty");
  });
});
