import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { fakeBackend, type Call, type FakeBackendOptions } from "@/test/backend";
import { entryOf, folderProjectOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

import DeleteProjectDialog from "@/project/DeleteProjectDialog.vue";
import EditProjectDialog from "@/project/EditProjectDialog.vue";

import HomeScreen from "./HomeScreen.vue";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

const CODE = "/home/iker/code";
const NOW = Math.floor(Date.now() / 1000);

const api = entryOf(`${CODE}/api`, { summary: summaryOf({ dirty: true }) });
const web = entryOf(`${CODE}/web`, { summary: summaryOf({ operation: "rebase", behind: 2 }) });
const webAuth = worktreeOf("/home/iker/wt/web-auth", web.path);
const probe = entryOf("/tmp/probe");

const projects = [
  projectOf(1, "Geoportal", [api.path, web.path], { pinned: true, openedAt: NOW - 3600 }),
  folderProjectOf(2, CODE, [api.path, web.path], [webAuth.path]),
  projectOf(3, "probe", [probe.path], { openedAt: NOW - 60 }),
];

function backend(options: FakeBackendOptions = {}): Call[] {
  return fakeBackend({
    repositories: [api, web, webAuth, probe],
    projects,
    rootIsPath: true,
    ...options,
  });
}

async function mountHome(options: FakeBackendOptions = {}) {
  const calls = backend(options);
  // The stores of this test, taken before anything waits.
  const index = useIndexStore();
  const store = useProjectsStore();
  await Promise.all([index.load(), store.load()]);
  const wrapper = mountWithI18n(HomeScreen, { attachTo: document.body });
  await flushPromises();
  return { wrapper, index, store, calls };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage({ lastScanAt: NOW - 120 }), "linux");
});

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

/** Each section of Home as its label and its count. */
function sections(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-testid^="home-section-"] > [role="presentation"]').map((header) =>
    header
      .findAll("span")
      .map((part) => part.text())
      .join(" "),
  );
}

/** Home with the project dialogs over it, as the shell renders them. */
function mountHomeWithDialogs() {
  const dialogs = useProjectDialogsStore();
  const Shell = defineComponent({
    setup: () => () =>
      h("div", [
        h(HomeScreen),
        dialogs.editing === null
          ? null
          : h(EditProjectDialog, { id: dialogs.editing, key: dialogs.editing }),
        dialogs.deleting === null
          ? null
          : h(DeleteProjectDialog, { id: dialogs.deleting, key: `delete:${dialogs.deleting}` }),
      ]),
  });
  return mountWithI18n(Shell, { attachTo: document.body });
}

/** The rows of a section, by name. */
function rowsOf(wrapper: VueWrapper, section: string): string[] {
  return wrapper
    .get(`[data-testid="home-section-${section}"]`)
    .findAll('[data-testid="home-project-name"]')
    .map((name) => name.text());
}

describe("HomeScreen", () => {
  it("lists the projects under Pinned, Recent and Projects, with their counts and what needs attention", async () => {
    const { wrapper } = await mountHome();
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe(
      "3 projects, 3 repositories and 1 worktree. Last scan 2 minutes ago.",
    );
    expect(sections(wrapper)).toEqual(["Pinned 1", "Recent 1", "Projects 3"]);
    expect(rowsOf(wrapper, "pinned")).toEqual(["Geoportal"]);
    expect(rowsOf(wrapper, "recent")).toEqual(["probe"]);
    expect(rowsOf(wrapper, "projects")).toEqual(["code", "Geoportal", "probe"]);
    const code = wrapper
      .get('[data-testid="home-section-projects"]')
      .findAll('[data-testid="home-project"]')[0]!;
    expect(code.get('[data-testid="home-project-folder"]').text()).toBe(CODE);
    // Its folder's own members by kind, the one added by hand among the repositories.
    expect(code.get('[data-testid="home-project-status"]').text()).toBe("3 repositories");
    expect(code.get('[data-testid="home-project-attention"]').text()).toBe(
      "1 with changes · 1 behind · 1 rebasing",
    );
    const probeRow = wrapper.get(
      '[data-testid="home-section-recent"] [data-testid="home-project"]',
    );
    expect(probeRow.find('[data-testid="home-project-folder"]').exists()).toBe(false);
    expect(probeRow.get('[data-testid="home-project-attention"]').text()).toBe("up to date");
    // One tab stop for the whole list.
    const stops = wrapper
      .findAll('[data-testid="home-project"]')
      .map((row) => row.attributes("tabindex"));
    expect(stops.filter((stop) => stop === "0")).toHaveLength(1);
    expect(wrapper.get('[data-testid="scan-start"]').text()).toBe("Scan");
    expect(wrapper.find('[data-testid="scan-stop"]').exists()).toBe(false);
  });

  it("moves with j and k and opens the focused project with Enter", async () => {
    const { wrapper, calls } = await mountHome();
    const rows = wrapper.findAll('[data-testid="home-project"]');
    (rows[0]?.element as HTMLElement).focus();
    // The first key selects the first row; the next ones move.
    await rows[0]!.trigger("keydown", { key: "j" });
    await rows[0]!.trigger("keydown", { key: "j" });
    await rows[1]!.trigger("keydown", { key: "j" });
    expect(rows[2]?.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows[2]?.element);
    await rows[2]!.trigger("keydown", { key: "k" });
    expect(rows[1]?.attributes("aria-selected")).toBe("true");
    // Recent's "probe": its only repository opens on the graph.
    await rows[1]!.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(useProjectsStore().active?.name).toBe("probe");
    expect(useRepoStore().repo?.root).toBe(probe.path);
    expect(calls.find((call) => call.cmd === "project_record_open")?.args).toEqual({
      id: 3,
      repository: probe.path,
    });
  });

  it("opens a project on a click", async () => {
    const { wrapper } = await mountHome();
    const geoportal = wrapper.get(
      '[data-testid="home-section-pinned"] [data-testid="home-project"]',
    );
    await geoportal.trigger("click");
    await flushPromises();
    expect(useProjectsStore().active?.name).toBe("Geoportal");
    expect(useRepoStore().repo?.root).toBe(api.path);
  });

  it("offers each project's menu: pin, edit, open its folder, and remove", async () => {
    const { wrapper, calls } = await mountHome();
    const code = wrapper
      .get('[data-testid="home-section-projects"]')
      .findAll('[data-testid="home-project"]')[0]!;
    await code.trigger("contextmenu", { clientX: 300, clientY: 400 });
    const menu = wrapper.get('[data-testid="project-row-menu"]');
    expect(menu.findAll("[role='menuitem']").map((item) => item.text())).toEqual([
      "Pin",
      "Edit project…",
      "Open in terminal",
      "Open in editor",
      "Remove project…",
    ]);
    await menu.get('[data-testid="menu-pin"]').trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.cmd === "project_set_pinned")?.args).toEqual({
      id: 2,
      pinned: true,
    });
    expect(rowsOf(wrapper, "pinned")).toEqual(["code", "Geoportal"]);
    // A list project has no folder to open.
    const probeRow = wrapper.get(
      '[data-testid="home-section-recent"] [data-testid="home-project"]',
    );
    await probeRow.trigger("contextmenu", { clientX: 10, clientY: 10 });
    const listMenu = wrapper.get('[data-testid="project-row-menu"]');
    expect(listMenu.find('[data-testid="menu-terminal"]').exists()).toBe(false);
    await listMenu.get('[data-testid="menu-remove"]').trigger("click");
    expect(useProjectDialogsStore().deleting).toBe(3);
  });

  it("shows the scanning state: Stop, the progress line and each folder project's state", async () => {
    const { wrapper, index } = await mountHome();
    index.scan = {
      kind: "scanning",
      folders: { [CODE]: "scanning" },
      scanned: 312,
      found: 14,
      current: CODE,
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe("Scanning 1 folder…");
    expect(wrapper.get('[data-testid="scan-stop"]').text()).toBe("Stop");
    expect(wrapper.get('[data-testid="scan-progress"]').text()).toBe(
      "312 folders scanned, 14 repositories found",
    );
    const code = wrapper
      .get('[data-testid="home-section-projects"]')
      .findAll('[data-testid="home-project"]')[0]!;
    // The count stays beside the scan's state, 16px apart (no middle dot).
    expect(code.get('[data-testid="home-project-status"]').text()).toBe("3 repositories");
    expect(code.get('[data-testid="home-project-scan"]').text()).toBe("scanning");
    index.scan = { ...index.scan, folders: { [CODE]: "queued" } };
    await flushPromises();
    expect(code.get('[data-testid="home-project-status"]').text()).toBe("3 repositories");
    expect(code.get('[data-testid="home-project-scan"]').text()).toBe("queued");
  });

  it("flags a folder project whose folder is gone, with its banner and Remove project", async () => {
    const { wrapper, index } = await mountHome();
    index.folderErrors = { [CODE]: { reason: "The system cannot find the path specified." } };
    await flushPromises();
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe(
      "3 projects, 3 repositories and 1 worktree. One folder could not be scanned.",
    );
    const code = wrapper
      .get('[data-testid="home-section-projects"]')
      .findAll('[data-testid="home-project"]')[0]!;
    const scan = code.get('[data-testid="home-project-scan"]');
    expect(scan.text()).toBe("not found");
    expect(scan.classes()).toContain("text-danger");
    const banner = wrapper.get('[data-testid="scan-folder-error"]');
    expect(banner.text()).toContain(
      `Couldn't scan ${CODE}. The folder was removed. Remove its project, or open the folder again if it moved.`,
    );
    await banner.get('[data-testid="error-banner-toggle"]').trigger("click");
    expect(banner.get('[data-testid="error-banner-toggle"]').text()).toBe("Show details");
    expect(banner.get('[data-testid="error-banner-output"]').text()).toContain(
      "cannot find the path",
    );
    await banner.get("button[data-variant='secondary']").trigger("click");
    expect(useProjectDialogsStore().deleting).toBe(2);
  });

  it("starts New project… and a scan of every folder project from its header", async () => {
    const { wrapper, calls } = await mountHome();
    await wrapper.get('[data-testid="home-new-project"]').trigger("click");
    expect(useProjectDialogsStore().creating).toBe(true);
    await wrapper.get('[data-testid="scan-start"]').trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.cmd === "scan_folders")?.args["folders"]).toEqual([CODE]);
    await wrapper.get('[data-testid="home-open-folder"]').trigger("click");
    expect(wrapper.emitted("openFolder")).toHaveLength(1);
  });

  it("shows skeleton rows while the projects load, and the banner when they cannot be read", async () => {
    backend();
    const store = useProjectsStore();
    const wrapper = mountWithI18n(HomeScreen);
    expect(wrapper.findAll('[data-testid="skeleton-row"]')).toHaveLength(4);
    await store.load();
    await flushPromises();
    expect(wrapper.find('[data-testid="skeleton-row"]').exists()).toBe(false);
    clearMocks();
    backend({ failProjects: true });
    await store.load();
    await flushPromises();
    expect(wrapper.get('[data-testid="projects-error"]').text()).toContain(
      "Couldn't read the list of projects.",
    );
    wrapper.unmount();
  });

  it("shows the index's failure with Try again, and no line of what needs attention until it is read", async () => {
    backend({ failIndex: true });
    const [index, store] = [useIndexStore(), useProjectsStore()];
    await store.load();
    const wrapper = mountWithI18n(HomeScreen);
    await flushPromises();
    const code = () =>
      wrapper
        .get('[data-testid="home-section-projects"]')
        .findAll('[data-testid="home-project"]')[0]!;
    // Nothing is said of the repositories' states before the index is read.
    expect(code().get('[data-testid="home-project-attention"]').text()).toBe("");
    await index.load();
    await flushPromises();
    const banner = wrapper.get('[data-testid="projects-error"]');
    expect(banner.text()).toContain("Couldn't read the list of repositories.");
    expect(code().get('[data-testid="home-project-attention"]').text()).toBe("");
    clearMocks();
    backend();
    const retry = banner.findAll("button").find((button) => button.text() === "Try again");
    await retry!.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="projects-error"]').exists()).toBe(false);
    expect(code().get('[data-testid="home-project-attention"]').text()).toBe(
      "1 with changes · 1 behind · 1 rebasing",
    );
    wrapper.unmount();
  });

  it("keeps the focus in the dialog a row's menu opens, and gives it back to the row", async () => {
    backend();
    const [index, store] = [useIndexStore(), useProjectsStore()];
    await Promise.all([index.load(), store.load()]);
    const wrapper = mountHomeWithDialogs();
    await flushPromises();
    const code = () =>
      wrapper
        .get('[data-testid="home-section-projects"]')
        .findAll('[data-testid="home-project"]')[0]!;
    await code().trigger("contextmenu", { clientX: 300, clientY: 400 });
    await wrapper.get('[data-testid="menu-edit"]').trigger("click");
    await flushPromises();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.element.contains(document.activeElement)).toBe(true);
    await dialog.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(code().element);
    wrapper.unmount();
  });

  it("moves the selection and the focus to the row in a deleted project's place", async () => {
    backend();
    const [index, store] = [useIndexStore(), useProjectsStore()];
    await Promise.all([index.load(), store.load()]);
    const wrapper = mountHomeWithDialogs();
    await flushPromises();
    const code = wrapper
      .get('[data-testid="home-section-projects"]')
      .findAll('[data-testid="home-project"]')[0]!;
    await code.trigger("contextmenu", { clientX: 300, clientY: 400 });
    await wrapper.get('[data-testid="menu-remove"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="dialog-confirm"]').trigger("click");
    await flushPromises();
    expect(rowsOf(wrapper, "projects")).toEqual(["Geoportal", "probe"]);
    const focused = document.activeElement as HTMLElement;
    expect(focused.dataset["index"]).toBe("2");
    expect(focused.getAttribute("aria-selected")).toBe("true");
    expect(focused.textContent).toContain("Geoportal");
    wrapper.unmount();
  });

  it("renders in Spanish", async () => {
    backend();
    const index = useIndexStore();
    const store = useProjectsStore();
    await Promise.all([index.load(), store.load()]);
    const wrapper = mountWithI18n(HomeScreen, {}, { locale: "es" });
    await flushPromises();
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe(
      "3 proyectos, 3 repositorios y 1 worktree. Último escaneo hace 2 minutos.",
    );
    expect(sections(wrapper)).toEqual(["Fijados 1", "Recientes 1", "Proyectos 3"]);
    wrapper.unmount();
  });
});
