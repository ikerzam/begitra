import { emit } from "@tauri-apps/api/event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexEntry } from "@/ipc/schemas";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { changedFile } from "@/test/changes";

import { pathUnder, useFolderStore } from "./folder";
import { useIndexStore } from "./index";
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

  it("reads four repositories at a time", async () => {
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
    expect(of(calls, "diff")).toHaveLength(8);
    expect(folder.state).toBe("loading");
    expect(folder.checking).toHaveLength(6);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settled();
    expect(of(calls, "diff")).toHaveLength(12);
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
    folder.hide();
    await settled();
    expect(of(calls, "unwatch_folder")).toHaveLength(1);
    // The open repository, /r, is not the folder's: every engine the view opened closes.
    expect(of(calls, "close_repository").map((call) => call.args["root"])).toEqual([
      "/code/api",
      "/code/infra",
      "/code/web",
    ]);
    // Events after leaving reach nothing.
    const before = of(calls, "diff_paths").length;
    await emit("repo:changed", { repo: "/code/web", kinds: ["status"], paths: ["tiles.ts"] });
    await settled();
    expect(of(calls, "diff_paths")).toHaveLength(before);
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
