import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled, type Call } from "@/test/backend";
import { entryOf, folderProjectOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

import DeleteProjectDialog from "./DeleteProjectDialog.vue";
import EditProjectDialog from "./EditProjectDialog.vue";
import NewProjectDialog from "./NewProjectDialog.vue";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const { open: pickFolder } = await import("@tauri-apps/plugin-dialog");

const CODE = "/home/iker/code";
const GEO = `${CODE}/geo`;
const WT = "/home/iker/wt";
const api = entryOf(`${GEO}/api`, { summary: summaryOf({ dirty: true }) });
const web = entryOf(`${GEO}/web`, { summary: summaryOf({ behind: 2 }) });
const webAuth = worktreeOf(`${WT}/web-claude-auth`, web.path);
const infra = entryOf(`${GEO}/infra`, { summary: summaryOf({ operation: "rebase" }) });
const spike = entryOf("/tmp/tiles-spike");
const indexed = [api, web, webAuth, infra, spike];
const probe = entryOf("/elsewhere/probe");

/** Every indexed repository in a project, as the index keeps them. */
const base: Project[] = [
  folderProjectOf(10, GEO, [api.path, infra.path, web.path]),
  folderProjectOf(11, WT, [webAuth.path]),
  projectOf(12, "tiles-spike", [spike.path]),
];
const geoportal = projectOf(1, "Geoportal", [api.path, web.path, `${GEO}/gone`]);

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await settled();
}

async function load(projects: Project[] = [geoportal, ...base], repositories = [...indexed]) {
  const calls = fakeBackend({
    repositories,
    projects,
    summaries: { [probe.path]: probe.summary },
  });
  const [store, index] = [useProjectsStore(), useIndexStore()];
  await Promise.all([store.load(), index.load()]);
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

describe("the new-project dialog", () => {
  it("makes a project of the checked repositories in the list's order and opens it", async () => {
    const calls = await load(base);
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
    // The new project opens on the graph of its first repository.
    expect(useProjectsStore().active?.name).toBe("Geoportal");
    expect(useShellStore().layoutMode).toBe("graph");
    expect(of(calls, "open_repository").at(-1)?.args["path"]).toBe(api.path);
    wrapper.unmount();
  });

  it("groups the list by project and narrows it with the filter", async () => {
    await load(base);
    const wrapper = mountWithI18n(NewProjectDialog, { attachTo: document.body });
    await flush();
    const names = () =>
      qa('[data-testid="checklist-item"]').map((item) => item.textContent?.trim());
    const groups = () => qa('[data-testid="checklist-group"]').map((g) => g.textContent?.trim());
    expect(groups()).toEqual([GEO, "tiles-spike", WT]);
    expect(names()).toEqual(["api", "infra", "web", "tiles-spike", "web-claude-auth"]);
    const filter = q<HTMLInputElement>('[data-testid="new-project-filter"]');
    if (!filter) throw new Error("no filter");
    filter.value = "web";
    filter.dispatchEvent(new Event("input"));
    await flush();
    expect(names()).toEqual(["web", "web-claude-auth"]);
    wrapper.unmount();
  });

  it("lists a repository two projects hold once, under the first by name", async () => {
    await load([geoportal, ...base]);
    const wrapper = mountWithI18n(NewProjectDialog, { attachTo: document.body });
    await flush();
    const paths = qa('[data-testid="checklist-item"]').map((item) => item.dataset["path"]);
    expect(paths.filter((path) => path === api.path)).toHaveLength(1);
    // "geo" sorts before "Geoportal", which lists nothing else that is there.
    const groups = qa('[data-testid="checklist-group"]').map((g) => g.textContent?.trim());
    expect(groups).toEqual([GEO, "tiles-spike", WT]);
    wrapper.unmount();
  });

  it("walks the checklist with the arrows and j/k from one tab stop", async () => {
    await load(base);
    const wrapper = mountWithI18n(NewProjectDialog, { attachTo: document.body });
    await flush();
    const boxes = () => qa('[data-testid="checklist-item"] input');
    const stops = () => boxes().filter((box) => box.tabIndex === 0);
    expect(stops()).toEqual([boxes()[0]]);
    boxes()[0]?.focus();
    boxes()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flush();
    expect(document.activeElement).toBe(boxes()[1]);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", bubbles: true }),
    );
    await flush();
    expect(document.activeElement).toBe(boxes()[2]);
    expect(stops()).toEqual([boxes()[2]]);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", bubbles: true }),
    );
    await flush();
    expect(document.activeElement).toBe(boxes()[1]);
    wrapper.unmount();
  });

  it("says when there is no repository to add, and when none matches the filter", async () => {
    await load([], []);
    const wrapper = mountWithI18n(NewProjectDialog, { attachTo: document.body });
    await flush();
    const empty = () => q('[data-testid="checklist-empty"]')?.textContent?.trim();
    expect(empty()).toBe("No repository to add.");
    const filter = q<HTMLInputElement>('[data-testid="new-project-filter"]');
    if (!filter) throw new Error("no filter");
    filter.value = "tiles";
    filter.dispatchEvent(new Event("input"));
    await flush();
    expect(empty()).toBe("No repository matches.");
    wrapper.unmount();
  });

  it("describes a repository the index does not know yet, checked, and stores it only once the project is made", async () => {
    const calls = await load(base);
    vi.mocked(pickFolder).mockResolvedValue(probe.path);
    const wrapper = mountWithI18n(NewProjectDialog, { attachTo: document.body });
    await flush();
    q<HTMLButtonElement>('[data-testid="new-project-add"]')?.click();
    await flush();
    expect(of(calls, "refresh_repository").at(-1)?.args).toMatchObject({
      path: probe.path,
      dirty: false,
    });
    const added = q<HTMLInputElement>(
      `[data-testid="checklist-item"][data-path="${probe.path}"] input`,
    );
    expect(added?.checked).toBe(true);
    expect(qa('[data-testid="checklist-group"]').at(-1)?.textContent?.trim()).toBe("Added");
    // The probe stored nothing: the listing does not hold it until a project names it.
    expect(useIndexStore().find(probe.path)).toBeUndefined();
    wrapper.unmount();
  });
});

describe("the edit dialog", () => {
  async function editing(projects?: Project[], id = 1) {
    const calls = await load(projects);
    useProjectDialogsStore().edit(id);
    const wrapper = mountWithI18n(EditProjectDialog, {
      props: { id },
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
    // `gone` belongs to no other project: the dialog names it before Save.
    expect(q('[data-testid="edit-project-leaving"]')?.textContent).toContain(
      "Leaves Begitra when you save",
    );
    expect(q('[data-testid="leaving-list"]')?.textContent).toContain("gone");
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

  it("sets how often the project fetches in the background, Save enabled by that alone", async () => {
    const { calls, wrapper } = await editing();
    const button = q<HTMLButtonElement>(
      '[data-testid="edit-project-fetch"] [data-testid="select-button"]',
    );
    if (!button) throw new Error("no fetch field");
    expect(button.textContent?.trim()).toBe("Only by hand");
    const hint = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toContain("In the background while the project is open");
    const save = () =>
      q<HTMLButtonElement>('[data-testid="edit-project-dialog"] [data-testid="dialog-confirm"]');
    expect(save()?.disabled).toBe(true);
    button.click();
    await flush();
    q<HTMLElement>(
      '[data-testid="edit-project-fetch"] [data-testid="option"][data-value="15"]',
    )?.click();
    await flush();
    expect(button.textContent?.trim()).toBe("Every 15 minutes");
    expect(save()?.disabled).toBe(false);
    save()?.click();
    await flush();
    expect(useSettingsStore().values.backgroundFetch).toEqual({ "1": 15 });
    expect(of(calls, "project_rename")).toHaveLength(0);
    expect(of(calls, "project_set_members")).toHaveLength(0);
    wrapper.unmount();
  });

  it("keeps a folder project's own repositories fixed and edits the ones added by hand", async () => {
    const own = folderProjectOf(20, GEO, [api.path, infra.path], [spike.path, webAuth.path]);
    const { calls, wrapper } = await editing([own, ...base.slice(1)], 20);
    const fixed = qa('[data-testid="edit-project-own"] li').map((row) => row.textContent?.trim());
    expect(fixed).toEqual(["api", "infra"]);
    expect(q('[data-testid="edit-project-own"] [data-testid="edit-project-remove"]')).toBeNull();
    expect(members()).toEqual(["tiles-spike", "web-claude-auth"]);
    qa('[data-testid="edit-project-remove"]')[0]?.click();
    await flush();
    // tiles-spike is in its own project too: nothing leaves Begitra.
    expect(q('[data-testid="edit-project-leaving"]')).toBeNull();
    q<HTMLButtonElement>(
      '[data-testid="edit-project-dialog"] [data-testid="dialog-confirm"]',
    )?.click();
    await flush();
    expect(of(calls, "project_set_members").at(-1)?.args).toEqual({
      id: 20,
      paths: [webAuth.path],
    });
    wrapper.unmount();
  });

  it("moves the focus with the arrows and removes the focused member with Delete", async () => {
    const { calls, wrapper } = await editing();
    const rows = () => qa('[data-testid="edit-project-members"] li[data-member]');
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    rows()[0]?.focus();
    rows()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flush();
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    rows()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await flush();
    expect(members()).toEqual(["api", "gone"]);
    // The focus stays on the row that took the removed one's place.
    expect(document.activeElement).toBe(rows()[1]);
    expect(q('[data-testid="edit-project-dialog"]')?.textContent).toContain(
      "Ctrl ↑ and Ctrl ↓ move the focused repository and Delete removes it.",
    );
    expect(of(calls, "project_set_members")).toHaveLength(0);
    wrapper.unmount();
  });

  it("keeps the focus in the dialog as Delete removes the last members", async () => {
    const { wrapper } = await editing();
    const rows = () => qa('[data-testid="edit-project-members"] li[data-member]');
    const press = (at: number) =>
      rows()[at]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    rows()[2]?.focus();
    press(2);
    await flush();
    expect(members()).toEqual(["api", "web"]);
    expect(document.activeElement).toBe(rows()[1]);
    press(1);
    await flush();
    press(0);
    await flush();
    expect(rows()).toHaveLength(0);
    expect(document.activeElement).toBe(q('[data-testid="edit-project-members"]'));
    wrapper.unmount();
  });

  it("stays open with its edits when the index refuses the save", async () => {
    const { wrapper } = await editing();
    const name = q<HTMLInputElement>('[data-testid="edit-project-name"]');
    if (!name) throw new Error("no name field");
    name.value = "Geo";
    name.dispatchEvent(new Event("input"));
    await flush();
    // From here on the index refuses every project write.
    const refusing = fakeBackend({ repositories: [...indexed], failProjects: true });
    q<HTMLButtonElement>(
      '[data-testid="edit-project-dialog"] [data-testid="dialog-confirm"]',
    )?.click();
    await flush();
    expect(of(refusing, "project_rename")).toHaveLength(1);
    expect(useProjectDialogsStore().editing).toBe(1);
    expect(q<HTMLInputElement>('[data-testid="edit-project-name"]')?.value).toBe("Geo");
    wrapper.unmount();
  });

  it("asks for the deletion in its own confirmation, which names what leaves Begitra", async () => {
    const { calls, wrapper } = await editing();
    q<HTMLButtonElement>('[data-testid="edit-project-delete"]')?.click();
    await flush();
    const dialogs = useProjectDialogsStore();
    expect(dialogs.editing).toBeNull();
    expect(dialogs.deleting).toBe(1);
    wrapper.unmount();
    const confirmation = mountWithI18n(DeleteProjectDialog, {
      props: { id: 1 },
      attachTo: document.body,
    });
    await flush();
    const dialog = q('[data-testid="delete-project-dialog"]');
    expect(dialog?.textContent).toContain("Delete Geoportal?");
    // api and web stay in the folder project of geo; the missing member leaves with it.
    expect(dialog?.textContent).toContain("this repository leaves Begitra with it");
    expect(q('[data-testid="leaving-list"]')?.textContent).toContain("gone");
    expect(q('[data-testid="leaving-list"]')?.textContent).not.toContain("api");
    dialog?.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]')?.click();
    await flush();
    expect(of(calls, "project_delete").at(-1)?.args).toEqual({ id: 1 });
    expect(useProjectsStore().find(1)).toBeUndefined();
    expect(dialogs.deleting).toBeNull();
    confirmation.unmount();
  });

  it("says nothing leaves Begitra when every repository belongs to another project", async () => {
    await load([projectOf(1, "Geoportal", [api.path, web.path]), ...base]);
    const confirmation = mountWithI18n(DeleteProjectDialog, {
      props: { id: 1 },
      attachTo: document.body,
    });
    await flush();
    expect(q('[data-testid="delete-project-dialog"]')?.textContent).toContain(
      "Its repositories belong to other projects and stay in Begitra",
    );
    expect(q('[data-testid="leaving-list"]')).toBeNull();
    confirmation.unmount();
  });
});
