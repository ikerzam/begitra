import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { entryOf, folderProjectOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

import ProjectLayout from "./ProjectLayout.vue";

const GEO = "/home/iker/code/geo";
const api = entryOf(`${GEO}/api`, { summary: summaryOf({ dirty: true, ahead: 2 }) });
const web = entryOf(`${GEO}/web`, {
  summary: summaryOf({ currentBranch: "claude/fix-auth", behind: 1, fetchedAt: null }),
});
const webAuth = worktreeOf("/home/iker/wt/web-claude-auth", web.path, {
  scanRoot: "/home/iker/wt",
});
const infra = entryOf(`${GEO}/infra`, {
  summary: summaryOf({ currentBranch: "release/2.4", operation: "rebase" }),
});
const gone = `${GEO}/old-spike`;
const indexed = [api, web, webAuth, infra];

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);
type Wrapper = ReturnType<typeof mountWithI18n>;
const rowNames = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="member-name"]').map((cell) => cell.text());
const row = (wrapper: Wrapper, name: string) => {
  const found = wrapper
    .findAll('[data-testid="member-row"]')
    .find((candidate) => candidate.get('[data-testid="member-name"]').text() === name);
  if (!found) throw new Error(`no row ${name}`);
  return found;
};

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await settled();
}

/** Makes project `id` the open one on its Overview, without opening a repository. */
function showOverview(id = 1): void {
  void useSettingsStore().update("activeProject", id);
  void useShellStore().setLayoutMode("overview");
}

async function mountProject(options: FakeBackendOptions = {}) {
  const calls = fakeBackend({
    repositories: indexed,
    projects: [projectOf(1, "Geoportal", [api.path, web.path, webAuth.path, infra.path, gone])],
    summaries: Object.fromEntries(indexed.map((entry) => [entry.path, entry.summary])),
    changesByRepo: {
      [api.path]: { unstaged: [changedFile("a.ts"), changedFile("b.ts")], staged: [] },
      [web.path]: { unstaged: [], staged: [] },
      [webAuth.path]: { unstaged: [changedFile("c.ts")], staged: [] },
      [infra.path]: { unstaged: [], staged: [] },
    },
    rootIsPath: true,
    ...options,
  });
  const projects = useProjectsStore();
  await Promise.all([projects.load(), useIndexStore().load()]);
  showOverview();
  const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
  await flush();
  return { calls, wrapper };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
  setShortcutRegistry(undefined);
  document.body.innerHTML = "";
});

describe("the project view", () => {
  it("shows the project's name, its count and its members in its order", async () => {
    const { wrapper } = await mountProject();
    expect(wrapper.get('[data-testid="project-title"]').text()).toBe("Geoportal");
    expect(wrapper.get('[data-testid="project-meta"]').text()).toBe("5 repositories");
    expect(rowNames(wrapper)).toEqual(["api", "web", "web-claude-auth", "infra", "old-spike"]);
    expect(row(wrapper, "api").get('[data-testid="member-changes"]').text()).toBe("2 files");
    expect(row(wrapper, "web").get('[data-testid="member-fetched"]').text()).toBe("never fetched");
    expect(row(wrapper, "infra").get('[data-testid="member-status"]').text()).toBe("Rebasing");
    expect(row(wrapper, "old-spike").get('[data-testid="member-status"]').text()).toBe(
      "Folder missing",
    );
    const groups = wrapper.findAll('[data-testid="branch-group"]').map((chip) => chip.text());
    expect(groups[0]).toBe("main2 of 5");
    wrapper.unmount();
  });

  it("shows skeleton rows, and no member as missing, until the index is read", async () => {
    const calls = fakeBackend({
      repositories: indexed,
      projects: [projectOf(1, "Geoportal", [api.path, web.path, gone])],
      summaries: Object.fromEntries(indexed.map((entry) => [entry.path, entry.summary])),
      rootIsPath: true,
    });
    const projects = useProjectsStore();
    await projects.load();
    showOverview();
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    await flush();
    expect(wrapper.findAll('[data-testid="member-row"]')).toHaveLength(0);
    expect(wrapper.findAll('[data-testid="skeleton-row"]').length).toBeGreaterThan(0);
    expect(wrapper.find('[data-testid="member-remove"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="project-meta"]').text()).toBe("reading 3 repositories");
    expect(of(calls, "refresh_repository")).toHaveLength(0);
    // Once the index is read the rows show, and each present member's summary is read again.
    await useIndexStore().load();
    await flush();
    expect(rowNames(wrapper)).toEqual(["api", "web", "old-spike"]);
    expect(wrapper.findAll('[data-testid="skeleton-row"]')).toHaveLength(0);
    expect(of(calls, "refresh_repository").map((call) => call.args["path"])).toEqual([
      api.path,
      web.path,
    ]);
    wrapper.unmount();
  });

  it("reads the members of another project shown while the view is open", async () => {
    const { calls, wrapper } = await mountProject({
      projects: [
        projectOf(1, "Geoportal", [api.path, web.path]),
        projectOf(2, "Infra", [infra.path, gone]),
      ],
    });
    const reads = () => of(calls, "refresh_repository").map((call) => call.args["path"]);
    expect(reads()).not.toContain(infra.path);
    showOverview(2);
    await flush();
    expect(rowNames(wrapper)).toEqual(["infra", "old-spike"]);
    expect(reads()).toContain(infra.path);
    wrapper.unmount();
  });

  it("keeps the view with its error when the projects cannot be read", async () => {
    fakeBackend({ repositories: indexed, failProjects: true });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    showOverview();
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    await flush();
    expect(useShellStore().layoutMode).toBe("overview");
    const banner = wrapper.get('[data-testid="overview-error"]');
    expect(banner.text()).toContain("Try again");
    // The output is the index's, not git's.
    expect(banner.text()).toContain("Hide output");
    expect(wrapper.find('[data-testid="project-meta"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("reaches a row's buttons with the right and left arrows", async () => {
    const { wrapper } = await mountProject();
    const apiRow = row(wrapper, "api");
    const element = apiRow.element as HTMLElement;
    element.focus();
    await apiRow.trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(apiRow.get('[data-testid="member-terminal"]').element);
    await apiRow.get('[data-testid="member-terminal"]').trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(apiRow.get('[data-testid="member-editor"]').element);
    await apiRow.get('[data-testid="member-editor"]').trigger("keydown", { key: "ArrowLeft" });
    await apiRow.get('[data-testid="member-terminal"]').trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).toBe(element);
    // A missing member's "Remove from project" is one of its row's buttons, not a Tab stop.
    const remove = row(wrapper, "old-spike").get('[data-testid="member-remove"]');
    expect(remove.attributes("tabindex")).toBe("-1");
    expect(remove.attributes("data-row-action")).toBeDefined();
    wrapper.unmount();
  });

  it("opens a member on a double click of its row, never of one of its buttons", async () => {
    const { calls, wrapper } = await mountProject();
    const opens = () => of(calls, "open_repository").length;
    const before = opens();
    // Two quick clicks on "Remove from project", "Show output" or the terminal are the button's.
    await row(wrapper, "old-spike").get('[data-testid="member-remove"]').trigger("dblclick");
    await row(wrapper, "api").get('[data-testid="member-terminal"]').trigger("dblclick");
    await flush();
    expect(opens()).toBe(before);
    await row(wrapper, "api").get('[data-testid="member-name"]').trigger("dblclick");
    await flush();
    expect(of(calls, "open_repository").at(-1)?.args["path"]).toBe(api.path);
    wrapper.unmount();
  });

  it("removes a missing member from the project from its row, asking first as it leaves Begitra", async () => {
    const { calls, wrapper } = await mountProject();
    await row(wrapper, "old-spike").get('[data-testid="member-remove"]').trigger("click");
    await flush();
    // No other project holds it: the confirmation names it first.
    expect(useProjectDialogsStore().removing).toBe(gone);
    expect(of(calls, "project_set_members")).toHaveLength(0);
    await useProjectsStore().removeMember(gone);
    await flush();
    expect(of(calls, "project_set_members").at(-1)?.args["paths"]).toEqual([
      api.path,
      web.path,
      webAuth.path,
      infra.path,
    ]);
    expect(rowNames(wrapper)).not.toContain("old-spike");
    wrapper.unmount();
  });

  it("moves between the Overview and the Changes keeping the watchers and the reads", async () => {
    const { calls, wrapper } = await mountProject();
    const watches = of(calls, "watch_folder").length;
    expect(wrapper.get('[data-testid="edit-project"]').attributes("aria-label")).toBe(
      "Edit project…",
    );
    void useShellStore().setLayoutMode("changes");
    await flush();
    expect(wrapper.find('[data-testid="folder-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="edit-project"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="project-meta"]').text()).toBe(
      "2 repositories with changes, 2 without",
    );
    void useShellStore().setLayoutMode("overview");
    await flush();
    expect(of(calls, "unwatch_folder")).toHaveLength(0);
    expect(of(calls, "watch_folder")).toHaveLength(watches);
    wrapper.unmount();
    await flush();
    expect(of(calls, "unwatch_folder")).toHaveLength(1);
  });

  it("moves with j and k, selects with Space and Ctrl A, and opens with Enter", async () => {
    const { calls, wrapper } = await mountProject();
    const table = wrapper.get('[data-testid="overview-table"]');
    await table.trigger("keydown", { key: "j" });
    await table.trigger("keydown", { key: "j" });
    await table.trigger("keydown", { key: " " });
    const selected = () =>
      wrapper
        .findAll('[data-testid="member-row"]')
        .filter((candidate) => candidate.get("input").element.checked)
        .map((candidate) => candidate.get('[data-testid="member-name"]').text());
    expect(selected()).toEqual(["web"]);
    await table.trigger("keydown", { key: "a", ctrlKey: true });
    expect(selected()).toHaveLength(5);
    await table.trigger("keydown", { key: "Escape" });
    expect(selected()).toEqual([]);
    await table.trigger("keydown", { key: "Enter" });
    await flush();
    expect(of(calls, "open_repository").at(-1)?.args["path"]).toBe(web.path);
    expect(useRepoStore().repo?.root).toBe(web.path);
    expect(useShellStore().layoutMode).toBe("graph");
    wrapper.unmount();
  });

  it("shows skeleton rows while the index loads, then its error with Try again", async () => {
    fakeBackend({ failIndex: true, projects: [projectOf(1, "Geoportal", [api.path, web.path])] });
    const projects = useProjectsStore();
    await projects.load();
    showOverview();
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    expect(
      wrapper.findAll('[data-testid="overview-table"] [data-testid="skeleton-row"]').length,
    ).toBeGreaterThan(0);
    await useIndexStore().load();
    await flush();
    expect(wrapper.find('[data-testid="overview-error"]').text()).toContain("Try again");
    // A list that could not be read has no count.
    expect(wrapper.find('[data-testid="project-meta"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("says a project without members is empty, with Edit project", async () => {
    fakeBackend({ projects: [projectOf(1, "Geoportal", [])] });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    showOverview();
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    await flush();
    const empty = wrapper.get('[data-testid="overview-empty"]');
    expect(empty.text()).toContain("No repositories in Geoportal.");
    expect(empty.text()).toContain("Edit project…");
    wrapper.unmount();
  });
});

describe("a folder project's Overview", () => {
  it("names its own members by their path under its folder", async () => {
    const deep = entryOf(`${GEO}/apps/web`);
    fakeBackend({
      repositories: [api, deep, infra],
      projects: [folderProjectOf(1, GEO, [api.path, deep.path, infra.path])],
      summaries: Object.fromEntries([api, deep, infra].map((e) => [e.path, e.summary])),
      changesByRepo: {
        [api.path]: { unstaged: [], staged: [] },
        [deep.path]: { unstaged: [], staged: [] },
        [infra.path]: { unstaged: [], staged: [] },
      },
    });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    showOverview();
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    await flush();
    expect(wrapper.get('[data-testid="project-title"]').text()).toBe("geo");
    expect(rowNames(wrapper)).toEqual(["api", "apps/web", "infra"]);
    wrapper.unmount();
  });

  it("offers Scan again when its folder holds no repository", async () => {
    const calls = fakeBackend({ projects: [folderProjectOf(1, GEO, [])] });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    showOverview();
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    await flush();
    const empty = wrapper.get('[data-testid="overview-empty"]');
    expect(empty.text()).toContain("No repositories in geo.");
    await empty.get("button").trigger("click");
    expect(of(calls, "scan_folders").at(-1)?.args["folders"]).toEqual([GEO]);
    wrapper.unmount();
  });
});
