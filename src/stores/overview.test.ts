import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { entryOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";

import { useFolderStore } from "./folder";
import { useIndexStore } from "./index";
import { READS_AT_ONCE, useOverviewStore } from "./overview";
import { useProjectsStore } from "./projects";
import { memoryStorage, useSettingsStore } from "./settings";

const GEO = "/home/iker/code/geo";
const api = entryOf(`${GEO}/api`, { summary: summaryOf({ dirty: true, ahead: 2 }) });
const web = entryOf(`${GEO}/web`, {
  summary: summaryOf({ currentBranch: "claude/fix-auth", behind: 1 }),
});
const webAuth = worktreeOf("/home/iker/wt/web-claude-auth", web.path, {
  summary: summaryOf({ currentBranch: "claude/tile-cache" }),
});
const mapCore = entryOf(`${GEO}/map-core`);
const infra = entryOf(`${GEO}/infra`, {
  summary: summaryOf({ currentBranch: "release/2.4", operation: "rebase", fetchedAt: null }),
});
const gone = `${GEO}/old-spike`;
const all = [api, web, webAuth, mapCore, infra];

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);

async function showProject(options: FakeBackendOptions = {}) {
  const calls = fakeBackend({
    repositories: all,
    projects: [projectOf(1, "Geoportal", [...all.map((entry) => entry.path), gone])],
    summaries: Object.fromEntries(all.map((entry) => [entry.path, entry.summary])),
    changesByRepo: {
      [api.path]: { unstaged: [changedFile("a.ts"), changedFile("b.ts")], staged: [] },
      [web.path]: { unstaged: [], staged: [] },
      [webAuth.path]: { unstaged: [changedFile("c.ts")], staged: [] },
      [mapCore.path]: { unstaged: [], staged: [] },
      [infra.path]: { unstaged: [], staged: [changedFile("d.ts")] },
    },
    ...options,
  });
  const projects = useProjectsStore();
  await Promise.all([projects.load(), useIndexStore().load()]);
  await projects.open(1, "overview");
  useFolderStore().show();
  for (let i = 0; i < 4; i += 1) await settled();
  return { calls, overview: useOverviewStore() };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(() => {
  useFolderStore().hide();
  clearMocks();
});

describe("the Overview", () => {
  it("lists every member in the project's order from the index, a missing one flagged", async () => {
    const { overview } = await showProject();
    expect(overview.rows.map((row) => [row.name, row.missing, row.worktree])).toEqual([
      ["api", false, false],
      ["web", false, false],
      ["web-claude-auth", false, true],
      ["map-core", false, false],
      ["infra", false, false],
      ["old-spike", true, false],
    ]);
    const rebasing = overview.rows.find((row) => row.name === "infra");
    expect(rebasing?.operation).toBe("rebase");
    expect(rebasing?.fetchedAt).toBeNull();
    expect(overview.rows[0]?.upstream).toEqual({
      name: "origin/main",
      remote: "origin",
      branch: "main",
      pushRemote: "origin",
    });
  });

  it("counts each member's changed files once its lists are read", async () => {
    const { overview } = await showProject();
    const changed = Object.fromEntries(overview.rows.map((row) => [row.name, row.changed]));
    expect(changed).toEqual({
      api: 2,
      web: 0,
      "web-claude-auth": 1,
      "map-core": 0,
      infra: 1,
      "old-spike": null,
    });
  });

  it("groups the branches, most common first", async () => {
    const { overview } = await showProject();
    expect(overview.groups.map((group) => [group.branch, group.count])).toEqual([
      ["main", 2],
      ["claude/fix-auth", 1],
      ["claude/tile-cache", 1],
      ["release/2.4", 1],
    ]);
    expect(new Set(overview.groups.map((group) => group.lane)).size).toBe(4);
  });

  it("reads the summaries again four at a time and keeps a member's failure in its row", async () => {
    const { calls, overview } = await showProject({
      summaryDelayMs: 40,
      summaryErrors: {
        [infra.path]: {
          code: "repo.invalid",
          message: "The repository could not be opened",
          detail: "corrupt config",
        },
      },
    });
    overview.refresh();
    await settled();
    expect(of(calls, "refresh_repository")).toHaveLength(READS_AT_ONCE);
    expect(overview.readsLeft).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await settled();
    expect(of(calls, "refresh_repository").map((call) => call.args["path"])).toEqual(
      all.map((entry) => entry.path),
    );
    expect(overview.readsLeft).toBe(0);
    const failed = overview.rows.find((row) => row.name === "infra");
    expect(failed?.error?.detail).toBe("corrupt config");
    expect(overview.rows.filter((row) => row.error !== null)).toHaveLength(1);
  });

  it("flags a member whose folder went as missing, not as a failure", async () => {
    const { overview } = await showProject({
      summaryErrors: { [infra.path]: { code: "repo.not_found", message: "gone" } },
    });
    overview.refresh();
    for (let i = 0; i < 3; i += 1) await settled();
    const row = overview.rows.find((candidate) => candidate.name === "infra");
    expect(row?.missing).toBe(true);
    expect(row?.error).toBeNull();
  });

  it("selects rows, all of them, and acts on every row when none is selected", async () => {
    const { overview } = await showProject();
    expect(overview.targets).toHaveLength(6);
    overview.toggle(api.path);
    overview.toggle(infra.path);
    expect(overview.targets.map((row) => row.name)).toEqual(["api", "infra"]);
    overview.toggle(api.path);
    expect(overview.targets.map((row) => row.name)).toEqual(["infra"]);
    overview.selectAll();
    expect(overview.selection.size).toBe(6);
    overview.selectAll();
    expect(overview.selection.size).toBe(0);
  });

  it("forgets the selection of another project's rows", async () => {
    const { overview } = await showProject({
      projects: [
        projectOf(
          1,
          "Geoportal",
          all.map((entry) => entry.path),
        ),
        projectOf(2, "Tiles", [mapCore.path]),
      ],
    });
    overview.toggle(api.path);
    await useProjectsStore().open(2);
    await settled();
    expect(overview.rows.map((row) => row.name)).toEqual(["map-core"]);
    expect(overview.selection.size).toBe(0);
  });
});
