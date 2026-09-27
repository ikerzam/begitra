import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useFolderStore } from "@/stores/folder";
import { useIndexStore } from "@/stores/index";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { entryOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";
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
  await projects.open(1, "overview");
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

  it("removes a missing member from the project from its row", async () => {
    const { calls, wrapper } = await mountProject();
    await row(wrapper, "old-spike").get('[data-testid="member-remove"]').trigger("click");
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

  it("switches tabs keeping the watchers and the reads of the view", async () => {
    const { calls, wrapper } = await mountProject();
    const watches = of(calls, "watch_folder").length;
    await wrapper.get('[data-testid="project-tab-changes"]').trigger("click");
    await flush();
    expect(useSettingsStore().values.projectTab).toBe("changes");
    expect(wrapper.find('[data-testid="folder-view"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="project-meta"]').text()).toBe(
      "2 repositories with changes, 2 without",
    );
    await wrapper.get('[data-testid="project-tab-overview"]').trigger("click");
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
    fakeBackend({ failIndex: true, projects: [projectOf(1, "Geoportal", [api.path])] });
    const projects = useProjectsStore();
    await projects.load();
    await projects.open(1, "overview");
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    expect(
      wrapper.findAll('[data-testid="overview-table"] [data-testid="skeleton-row"]').length,
    ).toBeGreaterThan(0);
    await useIndexStore().load();
    await flush();
    expect(wrapper.find('[data-testid="overview-error"]').text()).toContain("Try again");
    wrapper.unmount();
  });

  it("says a project without members is empty, with Edit project", async () => {
    fakeBackend({ projects: [projectOf(1, "Geoportal", [])] });
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1, "overview");
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    await flush();
    const empty = wrapper.get('[data-testid="overview-empty"]');
    expect(empty.text()).toContain("No repositories in Geoportal.");
    expect(empty.text()).toContain("Edit project…");
    wrapper.unmount();
  });
});

describe("the folder view's Overview", () => {
  it("lists the folder's repositories as a project's and saves them as one, on the same tab", async () => {
    const calls = fakeBackend({
      repositories: [api, web, infra],
      summaries: Object.fromEntries([api, web, infra].map((entry) => [entry.path, entry.summary])),
      changesByRepo: {
        [api.path]: { unstaged: [], staged: [] },
        [web.path]: { unstaged: [], staged: [] },
        [infra.path]: { unstaged: [], staged: [] },
      },
    });
    await useIndexStore().load();
    await useFolderStore().open(GEO, "overview");
    const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
    await flush();
    expect(rowNames(wrapper)).toEqual(["api", "infra", "web"]);
    await wrapper.get('[data-testid="save-as-project"]').trigger("click");
    await flush();
    const made = of(calls, "project_create").at(-1)?.args;
    expect(made?.["name"]).toBe("geo");
    expect(made?.["paths"]).toEqual([api.path, infra.path, web.path]);
    expect(useShellStore().layoutMode).toBe("project");
    expect(useSettingsStore().values.projectTab).toBe("overview");
    wrapper.unmount();
  });
});
