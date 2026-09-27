import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HomeScreen from "@/discovery/HomeScreen.vue";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled, type Call } from "@/test/backend";
import { entryOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

import EditProjectDialog from "./EditProjectDialog.vue";
import NewProjectDialog from "./NewProjectDialog.vue";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const { open: pickFolder } = await import("@tauri-apps/plugin-dialog");

const CODE = "/home/iker/code";
const GEO = `${CODE}/geo`;
const api = entryOf(`${GEO}/api`, { scanRoot: GEO, summary: summaryOf({ dirty: true }) });
const web = entryOf(`${GEO}/web`, { scanRoot: GEO, summary: summaryOf({ behind: 2 }) });
const webAuth = worktreeOf("/home/iker/wt/web-claude-auth", web.path, {
  scanRoot: "/home/iker/wt",
});
const infra = entryOf(`${GEO}/infra`, {
  scanRoot: GEO,
  summary: summaryOf({ operation: "rebase" }),
});
const spike = entryOf("/tmp/tiles-spike", { scanRoot: null });
const indexed = [api, web, webAuth, infra, spike];
const probe = entryOf("/elsewhere/probe", { scanRoot: null });

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await settled();
}

async function load(
  projects = [projectOf(1, "Geoportal", [api.path, web.path, `${GEO}/gone`])],
  repositories = [...indexed],
) {
  const calls = fakeBackend({
    repositories,
    projects,
    summaries: { [probe.path]: probe.summary },
  });
  await useSettingsStore().update("scanRoots", [GEO, "/home/iker/wt"]);
  await Promise.all([useProjectsStore().load(), useIndexStore().load()]);
  return calls;
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

describe("Home's projects", () => {
  it("lists each project with its count and what needs attention, and opens its view", async () => {
    await load([
      projectOf(1, "Geoportal", [api.path, web.path, infra.path, `${GEO}/gone`]),
      projectOf(2, "Tiles", [spike.path]),
    ]);
    const wrapper = mountWithI18n(HomeScreen, { attachTo: document.body });
    await flush();
    const rows = wrapper.findAll('[data-testid="home-project"]');
    expect(rows.map((row) => row.text())).toEqual([
      "Geoportal4 repositories1 with changes · 1 behind · 1 rebasing · 1 missing",
      "Tiles1 repositoryup to date",
    ]);
    await rows[1]?.trigger("click");
    await flush();
    expect(useShellStore().layoutMode).toBe("project");
    expect(useSettingsStore().values.activeProject).toBe(2);
    wrapper.unmount();
  });

  it("saves a scan folder's section as a project in path order", async () => {
    const calls = await load([]);
    const wrapper = mountWithI18n(HomeScreen, { attachTo: document.body });
    await flush();
    expect(wrapper.find('[data-testid="home-projects"]').exists()).toBe(false);
    const saves = wrapper.findAll('[data-testid="save-folder-as-project"]');
    await saves[0]?.trigger("click");
    await flush();
    expect(of(calls, "project_create").at(-1)?.args).toEqual({
      name: "geo",
      paths: [api.path, infra.path, web.path],
    });
    expect(useShellStore().layoutMode).toBe("project");
    wrapper.unmount();
  });
});

describe("the new-project dialog", () => {
  it("makes a project of the checked repositories in the list's order and shows it", async () => {
    const calls = await load([]);
    useProjectDialogsStore().create();
    const wrapper = mountWithI18n(NewProjectDialog, { attachTo: document.body });
    await flush();
    const confirm = () => q<HTMLButtonElement>('[data-testid="dialog-confirm"]');
    expect(confirm()?.disabled).toBe(true);
    const name = q<HTMLInputElement>('[data-testid="new-project-name"]');
    if (!name) throw new Error("no name field");
    name.value = "  Geoportal ";
    name.dispatchEvent(new Event("input"));
    const box = (path: string) =>
      q<HTMLInputElement>(`[data-testid="checklist-item"][data-path="${path}"] input`);
    for (const entry of [webAuth, api, web]) {
      box(entry.path)?.click();
      await flush();
    }
    expect(confirm()?.textContent?.trim()).toBe("Create with 3 repositories");
    confirm()?.click();
    await flush();
    expect(of(calls, "project_create").at(-1)?.args).toEqual({
      name: "Geoportal",
      paths: [api.path, web.path, webAuth.path],
    });
    expect(useProjectDialogsStore().creating).toBe(false);
    expect(useShellStore().layoutMode).toBe("project");
    wrapper.unmount();
  });

  it("groups the list as Home does and narrows it with the filter", async () => {
    await load([]);
    const wrapper = mountWithI18n(NewProjectDialog, { attachTo: document.body });
    await flush();
    const names = () =>
      qa('[data-testid="checklist-item"]').map((item) => item.textContent?.trim());
    expect(names()).toEqual(["api", "infra", "web", "web-claude-auth", "tiles-spike"]);
    const filter = q<HTMLInputElement>('[data-testid="new-project-filter"]');
    if (!filter) throw new Error("no filter");
    filter.value = "web";
    filter.dispatchEvent(new Event("input"));
    await flush();
    expect(names()).toEqual(["web", "web-claude-auth"]);
    wrapper.unmount();
  });

  it("adds a repository the index does not know yet, checked", async () => {
    const repositories = [...indexed];
    const calls = await load([], repositories);
    // The backend knows the folder once it is added: its answer is the entry it stored.
    repositories.push(probe);
    vi.mocked(pickFolder).mockResolvedValue(probe.path);
    const wrapper = mountWithI18n(NewProjectDialog, { attachTo: document.body });
    await flush();
    q<HTMLButtonElement>('[data-testid="new-project-add"]')?.click();
    await flush();
    expect(of(calls, "refresh_repository").at(-1)?.args["path"]).toBe(probe.path);
    const added = q<HTMLInputElement>(
      `[data-testid="checklist-item"][data-path="${probe.path}"] input`,
    );
    expect(added?.checked).toBe(true);
    wrapper.unmount();
  });
});

describe("the edit dialog", () => {
  async function editing() {
    const calls = await load();
    useProjectDialogsStore().edit(1);
    const wrapper = mountWithI18n(EditProjectDialog, {
      props: { id: 1 },
      attachTo: document.body,
    });
    await flush();
    return { calls, wrapper };
  }
  const members = () =>
    qa('[data-testid="edit-project-members"] li[data-member]').map((row) =>
      row.querySelector("span.truncate")?.textContent?.trim(),
    );

  it("renames, reorders with Ctrl ↓, removes and adds, writing on Save only", async () => {
    const { calls, wrapper } = await editing();
    expect(members()).toEqual(["api", "web", "gone"]);
    expect(q('[data-testid="edit-project-members"]')?.textContent).toContain("missing");
    const name = q<HTMLInputElement>('[data-testid="edit-project-name"]');
    if (!name) throw new Error("no name field");
    name.value = "Geo";
    name.dispatchEvent(new Event("input"));
    const first = qa('[data-testid="edit-project-members"] li[data-member]')[0];
    first?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true }),
    );
    await flush();
    expect(members()).toEqual(["web", "api", "gone"]);
    qa('[data-testid="edit-project-remove"]')[2]?.click();
    await flush();
    q<HTMLButtonElement>('[data-testid="edit-project-add"]')?.click();
    await flush();
    q<HTMLInputElement>(`[data-testid="checklist-item"][data-path="${infra.path}"] input`)?.click();
    await flush();
    q<HTMLButtonElement>(
      '[data-testid="add-repositories-dialog"] [data-testid="dialog-confirm"]',
    )?.click();
    await flush();
    expect(members()).toEqual(["web", "api", "infra"]);
    expect(of(calls, "project_set_members")).toHaveLength(0);
    q<HTMLButtonElement>(
      '[data-testid="edit-project-dialog"] [data-testid="dialog-confirm"]',
    )?.click();
    await flush();
    expect(of(calls, "project_rename").at(-1)?.args).toEqual({ id: 1, name: "Geo" });
    expect(of(calls, "project_set_members").at(-1)?.args).toEqual({
      id: 1,
      paths: [web.path, api.path, infra.path],
    });
    wrapper.unmount();
  });

  it("deletes the project after one confirmation that no repository is touched", async () => {
    const { calls, wrapper } = await editing();
    q<HTMLButtonElement>('[data-testid="edit-project-delete"]')?.click();
    await flush();
    const confirmation = q('[data-testid="delete-project-dialog"]');
    expect(confirmation?.textContent).toContain("stay as they are");
    confirmation?.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]')?.click();
    await flush();
    expect(of(calls, "project_delete").at(-1)?.args).toEqual({ id: 1 });
    expect(useProjectsStore().projects).toEqual([]);
    expect(useProjectDialogsStore().editing).toBeNull();
    wrapper.unmount();
  });
});
