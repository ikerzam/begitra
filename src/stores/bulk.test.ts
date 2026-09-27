import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { entryOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";

import { BULK_AT_ONCE, progressOf, useBulkStore } from "./bulk";
import { useFolderStore } from "./folder";
import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useOverviewStore } from "./overview";
import { useProjectsStore } from "./projects";
import { memoryStorage, useSettingsStore } from "./settings";

const GEO = "/home/iker/code/geo";
const api = entryOf(`${GEO}/api`, { summary: summaryOf({ ahead: 2 }) });
const web = entryOf(`${GEO}/web`, { summary: summaryOf({ behind: 1 }) });
const webAuth = worktreeOf("/home/iker/wt/web-claude-auth", web.path, {
  summary: summaryOf({ currentBranch: "claude/auth", upstream: null }),
});
const infra = entryOf(`${GEO}/infra`, { summary: summaryOf({ dirty: true, ahead: 1 }) });
const tiles = entryOf(`${GEO}/tiles`);
const docs = entryOf(`${GEO}/docs`);
const members = [api, web, webAuth, infra, tiles, docs];

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);
const repos = (calls: Call[], cmd: string) => of(calls, cmd).map((call) => call.args["repo"]);

const diverged = {
  code: "git.cli_failed",
  message: "git merge failed",
  detail:
    "hint: Diverging branches can't be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.",
};
const signIn = {
  code: "git.cli_failed",
  message: "git fetch failed",
  detail: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
};

async function showProject(options: FakeBackendOptions = {}, paths = members) {
  const calls = fakeBackend({
    repositories: members,
    projects: [
      projectOf(
        1,
        "Geoportal",
        paths.map((entry) => entry.path),
      ),
    ],
    summaries: Object.fromEntries(members.map((entry) => [entry.path, entry.summary])),
    changesByRepo: Object.fromEntries(
      members.map((entry) => [entry.path, { unstaged: [], staged: [] }]),
    ),
    ...options,
  });
  const projects = useProjectsStore();
  await Promise.all([projects.load(), useIndexStore().load()]);
  await projects.open(1, "overview");
  useFolderStore().show();
  for (let i = 0; i < 4; i += 1) await settled();
  return calls;
}

async function finished(bulk: ReturnType<typeof useBulkStore>): Promise<void> {
  for (let i = 0; i < 200 && bulk.running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await settled();
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(() => {
  useFolderStore().hide();
  clearMocks();
});

describe("a bulk operation", () => {
  it("reads the percentage of git's progress lines", () => {
    expect(progressOf("Receiving objects:  45% (90/200), 1.20 MiB | 2.40 MiB/s")).toBe(45);
    expect(progressOf("remote: Counting objects: 100% (12/12), done.")).toBe(100);
    expect(progressOf("From github.com:ikerzam/geo")).toBeNull();
  });

  it("fetches once per repository, a worktree riding on its repository's fetch", async () => {
    const calls = await showProject({}, [api, webAuth, web]);
    const bulk = useBulkStore();
    bulk.ask("fetch");
    expect(bulk.plan).toBeNull();
    await finished(bulk);
    expect(repos(calls, "fetch").sort()).toEqual([api.path, web.path].sort());
    expect(of(calls, "fetch").every((call) => call.args["batch"] === true)).toBe(true);
    expect(bulk.states.get(webAuth.path)).toEqual({
      state: "done",
      outcome: "fetched-with",
      with: "web",
    });
    expect(bulk.states.get(api.path)).toEqual({ state: "done", outcome: "fetched" });
    // Each member's summary is read again after its operation.
    expect(repos(calls, "refresh_repository").length).toBeGreaterThan(0);
    expect(of(calls, "refresh_repository").map((call) => call.args["path"])).toEqual(
      expect.arrayContaining([api.path, web.path, webAuth.path]),
    );
  });

  it("does nothing while the Overview has no rows", async () => {
    fakeBackend({ repositories: [], projects: [projectOf(1, "Empty", [])] });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1, "overview");
    const bulk = useBulkStore();
    bulk.ask("fetch");
    bulk.ask("pull");
    expect(bulk.kind).toBeNull();
    expect(bulk.plan).toBeNull();
  });

  it("runs four at a time and never a repository and its worktree together", async () => {
    const calls = await showProject({ networkDelayMs: 40 });
    const overview = useOverviewStore();
    for (const entry of [api, web, webAuth, tiles, docs]) overview.toggle(entry.path);
    const bulk = useBulkStore();
    bulk.ask("pull");
    expect(bulk.plan?.acting.map((item) => item.name)).toEqual(["api", "web", "tiles", "docs"]);
    expect(bulk.plan?.skipped.map((item) => [item.name, item.reason])).toEqual([
      ["web-claude-auth", "no-upstream"],
    ]);
    bulk.confirm();
    await settled();
    expect(of(calls, "pull")).toHaveLength(BULK_AT_ONCE);
    expect(useOperationsStore().current?.label).toBe("operations.bulk.pull");
    await finished(bulk);
    expect(of(calls, "pull").every((call) => call.args["request"])).toBe(true);
    expect(of(calls, "pull")[0]?.args["request"]).toEqual({
      remote: null,
      branch: null,
      rebase: false,
      ffOnly: true,
    });
    expect(bulk.summary).toMatchObject({ done: 4, skipped: 1, failed: 0 });
    expect(useOperationsStore().current).toBeUndefined();
  });

  it("serialises a repository and its worktree when both pull", async () => {
    const withUpstream = worktreeOf("/home/iker/wt/web-claude-auth", web.path, {
      summary: summaryOf({ currentBranch: "claude/auth" }),
    });
    const calls = fakeBackend({
      repositories: [web, withUpstream],
      projects: [projectOf(1, "Geo", [web.path, withUpstream.path])],
      summaries: { [web.path]: web.summary, [withUpstream.path]: withUpstream.summary },
      changesByRepo: {
        [web.path]: { unstaged: [], staged: [] },
        [withUpstream.path]: { unstaged: [], staged: [] },
      },
      networkDelayMs: 30,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1, "overview");
    useFolderStore().show();
    await settled();
    const bulk = useBulkStore();
    bulk.ask("pull");
    bulk.confirm();
    await settled();
    expect(repos(calls, "pull")).toEqual([web.path]);
    await finished(bulk);
    expect(repos(calls, "pull")).toEqual([web.path, withUpstream.path]);
  });

  it("keeps a diverged member's reason and git's output, and retries it alone", async () => {
    const calls = await showProject({ networkErrors: { [web.path]: diverged } }, [api, web]);
    const bulk = useBulkStore();
    bulk.ask("pull");
    bulk.confirm();
    await finished(bulk);
    const failed = bulk.states.get(web.path);
    expect(failed).toMatchObject({
      state: "failed",
      reason: "diverged",
      message: "fatal: Not possible to fast-forward, aborting.",
    });
    expect(bulk.states.get(api.path)).toEqual({ state: "done", outcome: "fast-forward" });
    expect(bulk.failedPaths).toEqual([web.path]);
    bulk.retryFailed();
    await finished(bulk);
    expect(repos(calls, "pull")).toEqual([api.path, web.path, web.path]);
  });

  it("retries a sign-in failure alone with prompts allowed", async () => {
    const calls = await showProject({ networkErrors: { [infra.path]: signIn } }, [api, infra]);
    const bulk = useBulkStore();
    bulk.ask("fetch");
    await finished(bulk);
    expect(bulk.states.get(infra.path)).toMatchObject({ state: "failed", reason: "sign-in" });
    bulk.retryFailed();
    await finished(bulk);
    const retried = of(calls, "fetch").at(-1);
    expect(retried?.args["repo"]).toBe(infra.path);
    expect(retried?.args["batch"]).toBe(false);
  });

  it("pushes the current branch to its upstream's remote, skipping what it cannot push", async () => {
    const calls = await showProject({}, [api, web, webAuth]);
    const bulk = useBulkStore();
    bulk.ask("push");
    expect(bulk.plan?.acting.map((item) => item.name)).toEqual(["api"]);
    expect(Object.fromEntries(bulk.plan?.skipped.map((i) => [i.name, i.reason]) ?? [])).toEqual({
      web: "nothing-to-push",
      "web-claude-auth": "no-upstream",
    });
    bulk.confirm();
    await finished(bulk);
    expect(of(calls, "push").map((call) => call.args["request"])).toEqual([
      { remote: "origin", branch: "main", setUpstream: false, forceWithLease: false },
    ]);
    expect(bulk.states.get(api.path)).toEqual({ state: "done", outcome: "pushed" });
  });

  it("switches the clean members and skips one with uncommitted changes", async () => {
    const calls = await showProject({}, [api, infra, tiles]);
    const bulk = useBulkStore();
    bulk.ask("switch", "release/2.4");
    expect(bulk.plan?.skipped.map((item) => [item.name, item.reason])).toEqual([
      ["infra", "uncommitted"],
    ]);
    bulk.confirm();
    await finished(bulk);
    expect(of(calls, "switch").map((call) => [call.args["repo"], call.args["target"]])).toEqual([
      [api.path, { kind: "branch", name: "release/2.4" }],
      [tiles.path, { kind: "branch", name: "release/2.4" }],
    ]);
    expect(bulk.states.get(api.path)).toEqual({
      state: "done",
      outcome: "switched",
      with: "release/2.4",
    });
  });

  it("creates a branch from HEAD and says when it already exists", async () => {
    const calls = await showProject(
      {
        writeErrors: {
          [tiles.path]: {
            code: "git.cli_failed",
            message: "git branch failed",
            detail: "fatal: a branch named 'feat/x' already exists",
          },
        },
      },
      [api, tiles],
    );
    const bulk = useBulkStore();
    bulk.ask("create", "feat/x");
    bulk.confirm();
    await finished(bulk);
    expect(of(calls, "branch_create").map((call) => call.args)).toEqual([
      expect.objectContaining({ repo: api.path, name: "feat/x", start: "HEAD", checkout: true }),
      expect.objectContaining({ repo: tiles.path, name: "feat/x", start: "HEAD", checkout: true }),
    ]);
    expect(bulk.states.get(tiles.path)).toMatchObject({ state: "failed", reason: "branch-exists" });
  });

  it("stops the running fetches and never starts the queued ones", async () => {
    const calls = await showProject({ networkDelayMs: 60_000 });
    const bulk = useBulkStore();
    bulk.ask("fetch");
    await settled();
    expect(of(calls, "fetch")).toHaveLength(BULK_AT_ONCE);
    await bulk.stop();
    await settled();
    expect(bulk.running).toBe(false);
    expect(of(calls, "fetch")).toHaveLength(BULK_AT_ONCE);
    expect(of(calls, "cancel_operation")).toHaveLength(BULK_AT_ONCE);
    const states = [...bulk.states.values()].map((state) => state.state);
    expect(states.every((state) => state === "stopped")).toBe(true);
    expect(bulk.summary.stopped).toBe(members.length);
    bulk.dismiss();
    expect(bulk.kind).toBeNull();
    expect(bulk.states.size).toBe(0);
  });
});
