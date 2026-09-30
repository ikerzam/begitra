import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  entryOf,
  folderProjectOf,
  pathsOf,
  projectOf,
  summaryOf,
  worktreeOf,
} from "@/test/entries";
import {
  fakeBackend,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";

import { useIndexStore } from "./index";
import { useProjectDialogsStore } from "./projectDialogs";
import {
  attentionOf,
  neighbourOf,
  nestWorktrees,
  resolveMembers,
  useProjectsStore,
} from "./projects";
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

  it("names a folder project's own members by their path under its folder", () => {
    const deep = entryOf(`${GEO}/apps/web`);
    const members = resolveMembers(folderProjectOf(1, GEO, [api.path, deep.path], [webAuth.path]), [
      api,
      deep,
      webAuth,
    ]);
    expect(members.map((member) => [member.name, member.origin])).toEqual([
      ["api", "folder"],
      ["apps/web", "folder"],
      ["web-claude-auth", "hand"],
    ]);
  });

  it("matches a member whatever its spelling, as the index spells it", () => {
    const windows = entryOf("C:\\Code\\geo\\api");
    const [member] = resolveMembers(projectOf(1, "Win", ["c:/code/geo/api"]), [windows]);
    expect(member?.missing).toBe(false);
    expect(member?.path).toBe("C:\\Code\\geo\\api");
  });

  it("lists a worktree under its repository when both are members, and keeps the order otherwise", () => {
    const members = resolveMembers(geoportal, [api, web, webAuth, gone]);
    expect(members.map((member) => [member.name, member.nested])).toEqual([
      ["api", false],
      ["web", false],
      ["web-claude-auth", true],
      ["old-spike", false],
    ]);
    const alone = resolveMembers(projectOf(2, "Wt", [webAuth.path, api.path]), [api, webAuth]);
    expect(alone.map((member) => [member.name, member.nested])).toEqual([
      ["web-claude-auth", false],
      ["api", false],
    ]);
    expect(nestWorktrees([])).toEqual([]);
  });

  it("keeps the stored order when asked not to nest (the edit dialog)", () => {
    const members = resolveMembers(geoportal, [api, web, webAuth, gone], true, false);
    expect(members.map((member) => member.name)).toEqual([
      "api",
      "web-claude-auth",
      "web",
      "old-spike",
    ]);
  });

  it("flags no member missing until the index is read", () => {
    const members = resolveMembers(geoportal, [], false);
    expect(members.map((member) => member.missing)).toEqual([false, false, false, false]);
    expect(attentionOf(members)).toEqual({ changes: 0, behind: 0, operations: {}, missing: 0 });
    expect(neighbourOf(members, null, 1)).toBeNull();
  });

  it("counts what needs attention", () => {
    const attention = attentionOf(resolveMembers(geoportal, [api, web, webAuth, gone]));
    expect(attention).toEqual({ changes: 1, behind: 1, operations: { rebase: 1 }, missing: 1 });
  });

  it("finds the next and the previous present member, wrapping and skipping missing ones", () => {
    const members = resolveMembers(geoportal, [api, web, webAuth, gone]);
    expect(neighbourOf(members, api.path, 1)?.path).toBe(web.path);
    expect(neighbourOf(members, web.path, 1)?.path).toBe(webAuth.path);
    expect(neighbourOf(members, webAuth.path, 1)?.path).toBe(api.path);
    expect(neighbourOf(members, api.path, -1)?.path).toBe(webAuth.path);
    expect(neighbourOf(members, null, 1)?.path).toBe(api.path);
    expect(neighbourOf(members, "/elsewhere", -1)?.path).toBe(webAuth.path);
    expect(neighbourOf(resolveMembers(projectOf(2, "One", [api.path]), [api]), api.path, 1)).toBe(
      null,
    );
  });
});

describe("projects store", () => {
  it("lists, makes, renames, edits and deletes projects, by name, touching no repository", async () => {
    const calls = fakeBackend({
      projects: [projectOf(7, "tiles", [gone.path])],
      repositories: [api, web, gone],
    });
    const projects = useProjectsStore();
    const index = useIndexStore();
    await Promise.all([projects.load(), index.load()]);
    const made = await projects.create("Geoportal", [api.path, web.path, api.path]);
    expect(pathsOf(made!)).toEqual([api.path, web.path]);
    expect(projects.sorted.map((project) => project.name)).toEqual(["Geoportal", "tiles"]);
    await projects.rename(7, "Agents");
    expect(projects.sorted.map((project) => project.name)).toEqual(["Agents", "Geoportal"]);
    // `web` belongs to no other project: it leaves the index with the edit.
    const edited = await projects.setMembers(made?.id ?? 0, [api.path]);
    expect(pathsOf(edited!.project)).toEqual([api.path]);
    expect(edited?.removed).toEqual([web.path]);
    expect(index.find(web.path)).toBeUndefined();
    // Deleting "Agents" takes `old-spike`, which no other project holds, out of the index.
    expect(await projects.remove(7)).toEqual([gone.path]);
    expect(index.find(gone.path)).toBeUndefined();
    expect(projects.sorted.map((project) => project.name)).toEqual(["Geoportal"]);
    const writes = calls
      .map((call) => call.cmd)
      .filter((cmd) => !cmd.startsWith("project") && cmd !== "list_repositories");
    expect(writes).toEqual([]);
  });

  it("names the members that leave Begitra with a project, and keeps a shared one", async () => {
    fakeBackend({
      projects: [geoportal, projectOf(2, "Web", [web.path])],
      repositories: [api, web, webAuth, gone],
    });
    const projects = useProjectsStore();
    await projects.load();
    expect(projects.leaving(geoportal, pathsOf(geoportal))).toEqual([
      api.path,
      webAuth.path,
      gone.path,
    ]);
    expect(projects.holding(web.path).map((project) => project.name)).toEqual(["Geoportal", "Web"]);
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

  it("pins at once and reverts when the index refuses", async () => {
    const calls = fakeBackend({ projects: [geoportal] });
    const projects = useProjectsStore();
    await projects.load();
    await projects.setPinned(1, true);
    expect(projects.pinned.map((project) => project.name)).toEqual(["Geoportal"]);
    expect(of(calls, "project_set_pinned")[0]?.args).toEqual({ id: 1, pinned: true });
    fakeBackend({ projects: [geoportal], failProjects: true });
    await projects.setPinned(1, false);
    expect(projects.find(1)?.pinned).toBe(true);
  });

  it("keeps a pin over a listing of the projects read before the index stored it", async () => {
    const options: FakeBackendOptions = { projects: [geoportal] };
    fakeBackend(options);
    const projects = useProjectsStore();
    await projects.load();
    const gate = writeGate();
    options.listingGate = gate;
    // Read while Geoportal is not pinned, this listing lands after the pin was stored.
    const early = projects.load();
    await projects.setPinned(1, true);
    gate.release();
    await early;
    expect(projects.find(1)?.pinned).toBe(true);
    // A listing that starts afterwards reads the stored pin, and the pin is forgotten.
    const later = projects.load();
    gate.release();
    await later;
    expect(projects.find(1)?.pinned).toBe(true);
  });

  it("lists the pinned projects, then the recent ones, by their last opening", async () => {
    fakeBackend({
      projects: [
        projectOf(1, "Pinned", [], { pinned: true, openedAt: 50 }),
        projectOf(2, "Older", [], { openedAt: 10 }),
        projectOf(3, "Newer", [], { openedAt: 30 }),
        projectOf(4, "Never", []),
      ],
    });
    const projects = useProjectsStore();
    await projects.load();
    expect(projects.pinned.map((project) => project.name)).toEqual(["Pinned"]);
    expect(projects.recent.map((project) => project.name)).toEqual(["Newer", "Older"]);
  });

  it("opens a project on the graph of the repository it showed last, and records it", async () => {
    const calls = fakeBackend({
      projects: [{ ...geoportal, lastRepository: web.path }],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await useShellStore().setLayoutMode("settings");
    await projects.open(1);
    await settled();
    expect(useSettingsStore().values.activeProject).toBe(1);
    expect(useShellStore().layoutMode).toBe("graph");
    expect(useRepoStore().repo?.root).toBe(web.path);
    expect(of(calls, "project_record_open").at(-1)?.args).toEqual({ id: 1, repository: web.path });
    expect(projects.multi).toBe(true);
  });

  it("opens a project on its first present repository when the last one left it", async () => {
    fakeBackend({
      projects: [{ ...geoportal, lastRepository: "/elsewhere" }],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1);
    await settled();
    expect(useRepoStore().repo?.root).toBe(api.path);
  });

  it("shows a project without a present repository as its empty state", async () => {
    fakeBackend({ projects: [projectOf(4, "Empty", [])], rootIsPath: true });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(4);
    expect(projects.active?.name).toBe("Empty");
    expect(useRepoStore().state.kind).toBe("empty");
  });

  it("deleting the open project leaves for Home", async () => {
    fakeBackend({
      projects: [geoportal],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1);
    await settled();
    await projects.remove(1);
    expect(useSettingsStore().values.activeProject).toBeNull();
    expect(useRepoStore().state.kind).toBe("empty");
    expect(useShellStore().layoutMode).toBe("graph");
  });

  it("shows the next member of the open project after the shown repository", async () => {
    const calls = fakeBackend({
      projects: [geoportal],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1);
    await settled();
    await useShellStore().setLayoutMode("overview");
    expect(await projects.openNeighbour(1)).toBe(true);
    await settled();
    expect(useRepoStore().repo?.root).toBe(web.path);
    // The Overview gives way to the graph of the repository shown.
    expect(useShellStore().layoutMode).toBe("graph");
    await projects.openNeighbour(1);
    await settled();
    expect(useRepoStore().repo?.root).toBe(webAuth.path);
    await projects.openNeighbour(-1);
    await settled();
    expect(useRepoStore().repo?.root).toBe(web.path);
    expect(of(calls, "open_repository").map((call) => call.args["path"])).toEqual([
      api.path,
      web.path,
      webAuth.path,
      web.path,
    ]);
  });

  it("opens a picked repository in the project opened last among those holding it", async () => {
    const calls = fakeBackend({
      projects: [{ ...geoportal, openedAt: 10 }, projectOf(2, "Web", [web.path], { openedAt: 20 })],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.openPath(web.path);
    await settled();
    expect(of(calls, "project_for_path")[0]?.args["path"]).toBe(web.path);
    expect(projects.active?.name).toBe("Web");
    expect(useRepoStore().repo?.root).toBe(web.path);
    // A repository no project holds opens as a project of one, named after it.
    await projects.openPath("/tmp/tiles-spike");
    await settled();
    expect(projects.active?.name).toBe("tiles-spike");
    expect(pathsOf(projects.active!)).toEqual(["/tmp/tiles-spike"]);
    expect(useRepoStore().repo?.root).toBe("/tmp/tiles-spike");
  });

  it("opens a folder in no repository as its folder project, scanned, showing the first found", async () => {
    const calls = fakeBackend({ notRepositories: ["/home/iker/geo2"], rootIsPath: true });
    const projects = useProjectsStore();
    const index = useIndexStore();
    await Promise.all([projects.load(), index.load()]);
    await projects.openPath("/home/iker/geo2");
    expect(projects.active?.kind).toBe("folder");
    expect(projects.active?.folder).toBe("/home/iker/geo2");
    expect(of(calls, "scan_folders")[0]?.args["folders"]).toEqual(["/home/iker/geo2"]);
    expect(useRepoStore().state.kind).toBe("empty");
    // The scan's first find joins the project and shows at once.
    const found = entryOf("/home/iker/geo2/tiles");
    projects.noteFound(found, "/home/iker/geo2");
    await settled();
    expect(pathsOf(projects.active!)).toEqual([found.path]);
    expect(useRepoStore().repo?.root).toBe(found.path);
    projects.noteFound(entryOf("/home/iker/geo2/api"), "/home/iker/geo2");
    await settled();
    expect(pathsOf(projects.active!)).toEqual(["/home/iker/geo2/api", found.path]);
    expect(useRepoStore().repo?.root).toBe(found.path);
  });

  it("makes a folder of repositories a project from the settings and scans it", async () => {
    const calls = fakeBackend({});
    const projects = useProjectsStore();
    await projects.load();
    const made = await projects.createFolder("/home/iker/code");
    expect(made?.name).toBe("code");
    expect(projects.folders).toEqual(["/home/iker/code"]);
    expect(of(calls, "scan_folders")[0]?.args["folders"]).toEqual(["/home/iker/code"]);
    fakeBackend({ missingFolders: ["/nope"] });
    expect(await projects.createFolder("/nope")).toBeNull();
    expect(useToastsStore().toasts.at(-1)?.kind).toBe("error");
  });

  it("shows a repository of another project from the palette in the project opened last", async () => {
    fakeBackend({
      projects: [
        { ...geoportal, openedAt: 30 },
        projectOf(2, "Styles", [api.path], { openedAt: 10 }),
        projectOf(3, "Web", [web.path], { openedAt: 5 }),
      ],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(3);
    await settled();
    await projects.openRepository(api.path);
    await settled();
    expect(projects.active?.name).toBe("Geoportal");
    expect(useRepoStore().repo?.root).toBe(api.path);
    // A member of the open project stays in it.
    await projects.openRepository(web.path);
    await settled();
    expect(projects.active?.name).toBe("Geoportal");
    expect(useRepoStore().repo?.root).toBe(web.path);
  });

  it("reopens the open project at launch on the repository it showed, and Home for one gone", async () => {
    fakeBackend({
      projects: [{ ...geoportal, lastRepository: web.path }],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const settings = useSettingsStore();
    await settings.update("activeProject", 1);
    const projects = useProjectsStore();
    await projects.load();
    await projects.restore();
    await settled();
    expect(useRepoStore().repo?.root).toBe(web.path);

    setActivePinia(createPinia());
    await useSettingsStore().init(memoryStorage({ activeProject: 9, layoutMode: "overview" }));
    fakeBackend({ projects: [geoportal] });
    const again = useProjectsStore();
    await again.load();
    await again.restore();
    expect(useSettingsStore().values.activeProject).toBeNull();
    expect(useShellStore().layoutMode).toBe("graph");
    expect(useRepoStore().state.kind).toBe("empty");
  });

  it("takes a member added by hand out of the open project, asking first when it leaves Begitra", async () => {
    const calls = fakeBackend({
      projects: [geoportal, projectOf(2, "Web", [web.path])],
      repositories: [api, web, webAuth, gone],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1);
    await settled();
    // `web` is in "Web" too: it goes at once.
    projects.askRemoveMember(web.path);
    await settled();
    expect(pathsOf(projects.active!)).toEqual([api.path, webAuth.path, gone.path]);
    // `old-spike` is in no other project: the removal asks first.
    projects.askRemoveMember(gone.path);
    expect(useProjectDialogsStore().removing).toBe(gone.path);
    expect(of(calls, "project_set_members")).toHaveLength(1);
    await projects.removeMember(gone.path);
    expect(pathsOf(projects.active!)).toEqual([api.path, webAuth.path]);
    expect(useIndexStore().find(gone.path)).toBeUndefined();
  });

  it("scans the folder again to take one of a folder project's own members out", async () => {
    const own = folderProjectOf(5, GEO, [api.path, gone.path]);
    const calls = fakeBackend({ projects: [own], repositories: [api, gone], rootIsPath: true });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(5);
    await settled();
    projects.askRemoveMember(gone.path);
    await settled();
    expect(of(calls, "project_set_members")).toEqual([]);
    expect(of(calls, "scan_folders")[0]?.args["folders"]).toEqual([GEO]);
  });

  it("adds a worktree made from the open project to it, by hand", async () => {
    const calls = fakeBackend({
      projects: [projectOf(1, "Geo", [api.path, web.path])],
      repositories: [api, web],
      summaries: { [webAuth.path]: summaryOf() },
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1);
    await settled();
    await projects.join(webAuth.path);
    expect(pathsOf(projects.active!)).toEqual([api.path, web.path, webAuth.path]);
    // The index stores the new entry now that a project names it.
    expect(of(calls, "refresh_repository").map((call) => call.args["path"])).toContain(
      webAuth.path,
    );
  });

  it("turns the settings of a version before projects into projects, once", async () => {
    setActivePinia(createPinia());
    const storage = memoryStorage({
      scanRoots: ["/home/iker/code", "/home/iker/empty"],
      lastRepository: web.path,
      activeProject: null,
    });
    await useSettingsStore().init(storage, "linux");
    const calls = fakeBackend({
      projects: [
        folderProjectOf(1, "/home/iker/code", [api.path, web.path]),
        projectOf(2, "Web", [web.path], { openedAt: 5 }),
      ],
      repositories: [api, web],
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await projects.load();
    await projects.migrateSettings();
    // The empty scan folder had no project yet; the scanned one had.
    expect(of(calls, "project_create_folder").map((call) => call.args["folder"])).toEqual([
      "/home/iker/empty",
    ]);
    expect(projects.folders).toEqual(["/home/iker/code", "/home/iker/empty"]);
    // The last repository's project, opened last among those holding it, is the open one.
    expect(of(calls, "project_for_path")[0]?.args["path"]).toBe(web.path);
    expect(useSettingsStore().values.activeProject).toBe(2);
    expect(storage.data.has("scanRoots")).toBe(false);
    expect(storage.data.has("lastRepository")).toBe(false);
    expect(useSettingsStore().legacy).toBeNull();
    await projects.migrateSettings();
    expect(of(calls, "project_create_folder")).toHaveLength(1);
  });

  it("opens the folder view's folder project when the app was left on it", async () => {
    setActivePinia(createPinia());
    await useSettingsStore().init(
      memoryStorage({ layoutMode: "folder", folderView: "/home/iker/wt", scanRoots: [] }),
      "linux",
    );
    fakeBackend({ projects: [folderProjectOf(3, "/home/iker/wt", [])] });
    const projects = useProjectsStore();
    await projects.load();
    await projects.migrateSettings();
    expect(useSettingsStore().values.activeProject).toBe(3);
    expect(useSettingsStore().values.layoutMode).toBe("changes");
  });
});
