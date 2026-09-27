import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entryOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";
import { fakeBackend, settled, type Call } from "@/test/backend";

import { useIndexStore } from "./index";
import { attentionOf, neighbourOf, resolveMembers, useProjectsStore } from "./projects";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

const GEO = "/home/iker/code/geo";
const api = entryOf(`${GEO}/api`, { summary: summaryOf({ dirty: true, ahead: 2 }) });
const web = entryOf(`${GEO}/web`, {
  summary: summaryOf({ currentBranch: "claude/fix-auth", behind: 1, operation: "rebase" }),
});
const webAuth = worktreeOf("/home/iker/wt/web-claude-auth", web.path);
const gone = entryOf(`${GEO}/old-spike`, { missing: true });
const geoportal = projectOf(1, "Geoportal", [api.path, webAuth.path, web.path, gone.path]);

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(() => {
  clearMocks();
});

describe("project members", () => {
  it("keeps the project's order and flags what the index lacks or found gone", () => {
    const members = resolveMembers(
      projectOf(1, "Geo", [web.path, "/home/iker/code/never-indexed", api.path, gone.path]),
      [api, web, gone],
    );
    expect(members.map((member) => [member.name, member.missing])).toEqual([
      ["web", false],
      ["never-indexed", true],
      ["api", false],
      ["old-spike", true],
    ]);
    expect(members[1]?.entry).toBeNull();
  });

  it("names two members of the same name after their folders", () => {
    const tilesApi = entryOf("/home/iker/code/tiles/api");
    const members = resolveMembers(projectOf(1, "Both", [api.path, tilesApi.path]), [
      api,
      tilesApi,
    ]);
    expect(members.map((member) => member.name)).toEqual(["geo/api", "tiles/api"]);
  });

  it("matches a member whatever its spelling, as the index spells it", () => {
    const windows = entryOf("C:\\Code\\geo\\api");
    const [member] = resolveMembers(projectOf(1, "Win", ["c:/code/geo/api"]), [windows]);
    expect(member?.missing).toBe(false);
    expect(member?.path).toBe("C:\\Code\\geo\\api");
  });

  it("counts what needs attention", () => {
    const attention = attentionOf(resolveMembers(geoportal, [api, web, webAuth, gone]));
    expect(attention).toEqual({ changes: 1, behind: 1, operations: { rebase: 1 }, missing: 1 });
  });

  it("finds the next and the previous present member, wrapping and skipping missing ones", () => {
    const members = resolveMembers(geoportal, [api, web, webAuth, gone]);
    expect(neighbourOf(members, api.path, 1)?.path).toBe(webAuth.path);
    expect(neighbourOf(members, web.path, 1)?.path).toBe(api.path);
    expect(neighbourOf(members, api.path, -1)?.path).toBe(web.path);
    expect(neighbourOf(members, null, 1)?.path).toBe(api.path);
    expect(neighbourOf(members, "/elsewhere", -1)?.path).toBe(web.path);
    expect(neighbourOf(resolveMembers(projectOf(2, "One", [api.path]), [api]), api.path, 1)).toBe(
      null,
    );
  });
});

describe("projects store", () => {
  it("lists, makes, renames, edits and deletes projects, by name, touching no repository", async () => {
    const calls = fakeBackend({ projects: [projectOf(7, "tiles", [])] });
    const projects = useProjectsStore();
    await projects.load();
    const made = await projects.create("Geoportal", [api.path, web.path, api.path]);
    expect(made?.members).toEqual([api.path, web.path]);
    expect(projects.projects.map((project) => project.name)).toEqual(["Geoportal", "tiles"]);
    await projects.rename(7, "Agents");
    expect(projects.projects.map((project) => project.name)).toEqual(["Agents", "Geoportal"]);
    const edited = await projects.setMembers(made?.id ?? 0, [web.path]);
    expect(edited?.members).toEqual([web.path]);
    expect(await projects.remove(7)).toBe(true);
    expect(projects.projects.map((project) => project.name)).toEqual(["Geoportal"]);
    const writes = calls.map((call) => call.cmd).filter((cmd) => !cmd.startsWith("project"));
    expect(writes).toEqual([]);
  });

  it("drops a project that another window deleted when it answers null", async () => {
    fakeBackend({ projects: [projectOf(3, "Geo", [])] });
    const projects = useProjectsStore();
    await projects.load();
    fakeBackend({ projects: [] });
    expect(await projects.rename(3, "Other")).toBeNull();
    expect(projects.projects).toEqual([]);
  });

  it("keeps the list and says why when the index refuses", async () => {
    fakeBackend({ projects: [projectOf(3, "Geo", [])], failProjects: true });
    const projects = useProjectsStore();
    await projects.load();
    expect(projects.loadError?.code).toBe("index.database");
    expect(await projects.create("New", [])).toBeNull();
    expect(useToastsStore().toasts.at(-1)?.kind).toBe("error");
  });

  it("opens a project's view on a tab and remembers it", async () => {
    fakeBackend({ projects: [geoportal] });
    const projects = useProjectsStore();
    await projects.load();
    await projects.open(1, "changes");
    const settings = useSettingsStore();
    expect(settings.values.activeProject).toBe(1);
    expect(settings.values.projectTab).toBe("changes");
    expect(useShellStore().layoutMode).toBe("project");
    expect(projects.active?.name).toBe("Geoportal");
  });

  it("deleting the shown project leaves its view", async () => {
    fakeBackend({ projects: [geoportal] });
    const projects = useProjectsStore();
    await projects.load();
    await projects.open(1);
    await projects.remove(1);
    expect(useSettingsStore().values.activeProject).toBeNull();
    expect(useShellStore().layoutMode).toBe("graph");
  });

  it("opens the next member of the active project after the open repository", async () => {
    const calls = fakeBackend({
      projects: [geoportal],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1);
    expect(await projects.openNeighbour(1)).toBe(true);
    await settled();
    expect(useRepoStore().repo?.root).toBe(api.path);
    expect(useShellStore().layoutMode).toBe("graph");
    expect(projects.openIsMember).toBe(true);
    await projects.openNeighbour(1);
    await settled();
    expect(useRepoStore().repo?.root).toBe(webAuth.path);
    await projects.openNeighbour(-1);
    await settled();
    expect(useRepoStore().repo?.root).toBe(api.path);
    expect(of(calls, "open_repository").map((call) => call.args["path"])).toEqual([
      api.path,
      webAuth.path,
      api.path,
    ]);
  });
});
