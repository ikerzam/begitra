import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import type { IndexEntry } from "@/ipc/schemas";
import { useIndexStore } from "@/stores/index";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { mountWithI18n } from "@/test/mount";

import HomeScreen from "./HomeScreen.vue";
import { useDiscoveryFormat } from "./useDiscoveryFormat";

const dialogOpen = vi.fn<() => Promise<string | null>>(() => Promise.resolve("/home/iker/oss"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => dialogOpen() }));

const CODE = "/home/iker/code";
const WT = "/home/iker/wt";
const NOW = Math.floor(Date.now() / 1000);

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
      lastCommitAt: NOW - 3 * 3600,
      dirty: false,
    },
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: NOW,
    missing: false,
    ...over,
  };
}

const fixture: IndexEntry[] = [
  entry("geoportal", {
    pinned: true,
    lastOpenedAt: NOW - 100,
    summary: {
      currentBranch: "main",
      detached: false,
      ahead: 2,
      behind: 0,
      lastCommitAt: NOW - 3 * 3600,
      dirty: true,
    },
  }),
  entry("claude-auth", {
    path: `${WT}/claude-auth`,
    kind: "worktree",
    parentPath: `${CODE}/geoportal`,
    scanRoot: WT,
    summary: {
      currentBranch: "claude/fix-auth",
      detached: false,
      ahead: 5,
      behind: 1,
      lastCommitAt: NOW - 2 * 3600,
      dirty: true,
    },
  }),
  entry("tiles-spike", { lastOpenedAt: NOW - 7 * 86_400 }),
  entry("begitra", { summary: { ...entry("x").summary, lastCommitAt: NOW - 3600 } }),
  entry("map-core-bench", {
    summary: { ...entry("x").summary, currentBranch: "develop", lastCommitAt: NOW - 4 * 86_400 },
  }),
];

function backend() {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_repositories":
        return fixture;
      case "open_repository":
        return {
          root: args["path"],
          commonDir: `${args["path"] as string}/.git`,
          currentBranch: "main",
          detached: false,
          isLinkedWorktree: false,
        };
      case "list_refs":
        return [];
      case "walk_commits":
        return null;
      case "open_external":
        return ["code", args["path"]];
      default:
        return null;
    }
  });
  return calls;
}

async function mountHome(loaded = true) {
  const index = useIndexStore();
  if (loaded) {
    index.entries = fixture;
    index.loaded = true;
  }
  const wrapper = mountWithI18n(HomeScreen, { attachTo: document.body });
  await flushPromises();
  return { wrapper, index };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(
    memoryStorage({ scanRoots: [CODE, WT], lastScanAt: NOW - 120 }),
    "linux",
  );
  backend();
});

afterEach(() => {
  clearMocks();
  dialogOpen.mockClear();
});

/** Each section header of the home table as its label and, for a folder, its count. */
function sectionHeaders(wrapper: VueWrapper): string[][] {
  return wrapper
    .findAll('[data-testid^="section-"]')
    .map((header) => header.findAll("span").map((part) => part.text()));
}

describe("HomeScreen", () => {
  it("shows the counts, the folders with their counts and the sections from the index", async () => {
    const { wrapper } = await mountHome();
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe(
      "4 repositories and 1 worktree in 2 folders. Last scan 2 minutes ago.",
    );
    const folders = wrapper.findAll('[data-testid="scan-folder"]');
    expect(folders.map((f) => f.text())).toEqual([`${CODE}4 repositories`, `${WT}1 worktree`]);
    expect(wrapper.get('[data-testid="scan-start"]').text()).toBe("Scan");
    expect(wrapper.find('[data-testid="scan-stop"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="scan-progress"]').exists()).toBe(false);

    // Pinned, Recent, then the scan folder's own repositories under its path, with their count;
    // the worktree folder has no section, its worktree hangs under its repository.
    expect(sectionHeaders(wrapper)).toEqual([["Pinned"], ["Recent"], [CODE, "2"]]);
    const rows = wrapper.findAll('[data-testid="repo-row"]');
    expect(rows.map((row) => row.get('[data-testid="repo-row-name"]').text())).toEqual([
      "geoportal",
      "claude-auth",
      "tiles-spike",
      "begitra",
      "map-core-bench",
    ]);
    // The worktree hangs under its repository with the connector and its own branch colour.
    expect(rows[1]?.find('[data-testid="repo-row-connector"]').exists()).toBe(true);
    expect(rows[0]?.get("[data-lane]").attributes("data-lane")).toBe("1");
    expect(rows[1]?.get("[data-lane]").attributes("data-lane")).toBe("2");
    expect(rows[0]?.get('[data-testid="repo-row-last-commit"]').text()).toBe("3h ago");
    expect(rows[0]?.get('[data-testid="repo-row-path"]').text()).toBe(`${CODE}/geoportal`);
    expect(rows[0]?.find("[data-tooltip='Uncommitted changes']").exists()).toBe(true);
    expect(rows.map((row) => row.attributes("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1"]);
    expect(wrapper.find('[data-testid="skeleton-row"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("resizes a column from its header's edge for the header and every row, and resets it", async () => {
    const { wrapper } = await mountHome();
    const table = wrapper.get('[data-testid="repo-table"]');
    expect(table.attributes("style")).toContain("--repo-name-w: 200px");
    const edges = wrapper.findAll(
      '[data-testid="repo-table-columns"] [data-testid="column-resizer"]',
    );
    expect(edges).toHaveLength(4);
    const name = edges[0]!;
    expect(name.attributes("aria-label")).toBe("Resize the Name column");
    await name.trigger("mousedown", { clientX: 200 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 260 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await flushPromises();
    expect(useSettingsStore().values.columnWidths.home.name).toBe(260);
    expect(table.attributes("style")).toContain("--repo-name-w: 260px");
    await name.trigger("dblclick");
    await flushPromises();
    expect(useSettingsStore().values.columnWidths.home.name).toBe(200);
    wrapper.unmount();
  });

  it("sorts the All section from the column header and keeps the other sections", async () => {
    const { wrapper, index } = await mountHome();
    const names = () =>
      wrapper
        .findAll('[data-testid="repo-row"]')
        .map((row) => row.get('[data-testid="repo-row-name"]').text());
    await wrapper.get('[data-testid="sort-lastCommit"]').trigger("click");
    expect(index.sort).toEqual({ column: "lastCommit", direction: "desc" });
    expect(names().slice(3)).toEqual(["begitra", "map-core-bench"]);
    await wrapper.get('[data-testid="sort-lastCommit"]').trigger("click");
    expect(names().slice(3)).toEqual(["map-core-bench", "begitra"]);
    expect(wrapper.get('[data-testid="sort-lastCommit"]').attributes("aria-sort")).toBe(
      "ascending",
    );
    expect(wrapper.get('[data-testid="sort-name"]').attributes("aria-sort")).toBe("none");
    // The hint puts the column inside a sentence, for the eye and for assistive technology.
    const sortName = wrapper.get('[data-testid="sort-name"]');
    expect(sortName.attributes("data-tooltip")).toBe("Sort by name");
    expect(sortName.attributes("aria-description")).toBe("Sort by name");
    wrapper.unmount();
  });

  it("moves with j and k, opens the selected row with Enter and offers the row menu", async () => {
    const { wrapper } = await mountHome();
    const rows = wrapper.findAll('[data-testid="repo-row"]');
    (rows[0]?.element as HTMLElement).focus();
    await rows[0]!.trigger("keydown", { key: "j" });
    await rows[0]!.trigger("keydown", { key: "j" });
    expect(rows[1]?.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows[1]?.element);
    await rows[1]!.trigger("keydown", { key: "k" });
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    await rows[0]!.trigger("keydown", { key: "ArrowDown" });
    await rows[1]!.trigger("keydown", { key: "ArrowDown" });
    expect(rows[2]?.attributes("aria-selected")).toBe("true");

    await rows[2]!.trigger("contextmenu", { clientX: 300, clientY: 400 });
    const menu = wrapper.get('[data-testid="repo-row-menu"]');
    expect(menu.attributes("style")).toContain("left: 300px");
    expect(menu.findAll("[role='menuitem']").map((item) => item.text())).toEqual([
      "Pin",
      "Open in terminal",
      "Open in editor",
      "Remove from list",
    ]);
    await menu.get('[data-testid="menu-pin"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="repo-row-menu"]').exists()).toBe(false);
    expect(useIndexStore().pinned.map((e) => e.name)).toEqual(["geoportal", "tiles-spike"]);

    const current = wrapper.findAll('[data-testid="repo-row"]');
    const selected = current.find((row) => row.attributes("aria-selected") === "true");
    expect(selected?.get('[data-testid="repo-row-name"]').text()).toBe("tiles-spike");
    await selected!.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(useRepoStore().state.kind).toBe("ready");
    expect(useRepoStore().repo?.root).toBe(`${CODE}/tiles-spike`);
    wrapper.unmount();
  });

  it("shows the scanning state: Stop, folder states, the progress line and skeleton rows", async () => {
    const { wrapper, index } = await mountHome();
    index.scan = {
      kind: "scanning",
      folders: { [CODE]: "scanning", [WT]: "queued" },
      scanned: 312,
      found: 14,
      current: CODE,
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe("Scanning 2 folders…");
    expect(wrapper.get('[data-testid="scan-stop"]').text()).toBe("Stop");
    expect(
      wrapper.findAll('[data-testid="scan-folder-status"]').map((status) => status.text()),
    ).toEqual(["scanning", "queued"]);
    expect(wrapper.get('[data-testid="scan-progress"]').text()).toBe(
      "312 folders scanned, 14 repositories found",
    );
    expect(sectionHeaders(wrapper).at(-1)).toEqual([CODE, "2 so far"]);
    // The skeleton rows stand in the group of the folder being walked, which its header names.
    const walked = wrapper.findAll('[role="group"]').at(-1);
    expect(walked?.findAll('[data-testid="skeleton-row"]')).toHaveLength(4);
    expect(wrapper.findAll('[data-testid="skeleton-row"]')).toHaveLength(4);
    const label = document.getElementById(walked?.attributes("aria-labelledby") ?? "");
    expect(label?.textContent).toContain(CODE);

    // Once the folder is done its count is final, while the scan goes on elsewhere.
    index.scan = { ...index.scan, folders: { [CODE]: "done", [WT]: "scanning" }, current: WT };
    await flushPromises();
    expect(sectionHeaders(wrapper).at(-1)).toEqual([CODE, "2"]);
    wrapper.unmount();
  });

  it("flags a folder that could not be scanned and removes it from the banner", async () => {
    const { wrapper, index } = await mountHome();
    index.folderErrors = { [WT]: { reason: "The system cannot find the path specified." } };
    await flushPromises();
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe(
      "4 repositories and 1 worktree in 2 folders. One folder could not be scanned.",
    );
    const statuses = wrapper.findAll('[data-testid="scan-folder-status"]');
    expect(statuses[1]?.text()).toBe("not found");
    expect(statuses[1]?.classes()).toContain("text-danger");
    const banner = wrapper.get('[data-testid="scan-folder-error"]');
    expect(banner.text()).toContain(
      `Couldn't scan ${WT}. The folder was removed. Remove it from the scan folders, or add it again if it moved.`,
    );
    await banner.get('[data-testid="error-banner-toggle"]').trigger("click");
    expect(banner.get('[data-testid="error-banner-output"]').text()).toContain(
      "cannot find the path",
    );
    await banner.get("button[data-variant='secondary']").trigger("click");
    await flushPromises();
    expect(useSettingsStore().values.scanRoots).toEqual([CODE]);
    expect(wrapper.find('[data-testid="scan-folder-error"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("adds a folder from the picker, and removes one with its button", async () => {
    const { wrapper, index } = await mountHome();
    await wrapper.get('[data-testid="add-folder"]').trigger("click");
    await flushPromises();
    expect(useSettingsStore().values.scanRoots).toEqual([CODE, WT, "/home/iker/oss"]);
    expect(index.scan).toMatchObject({ kind: "scanning", folders: { "/home/iker/oss": "queued" } });
    await wrapper.findAll('[data-testid="remove-folder"]')[0]!.trigger("click");
    await flushPromises();
    expect(useSettingsStore().values.scanRoots).toEqual([WT, "/home/iker/oss"]);
    wrapper.unmount();
  });

  it("shows skeleton rows before the index loads, the empty sentence with nothing found, and the error", async () => {
    const { wrapper, index } = await mountHome(false);
    expect(wrapper.findAll('[data-testid="skeleton-row"]')).toHaveLength(4);
    index.loaded = true;
    await flushPromises();
    expect(wrapper.find('[data-testid="skeleton-row"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="repo-table-empty"]').text()).toBe(
      "No repositories found under the scan folders. Scan again, or add another folder.",
    );
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe(
      "0 repositories in 2 folders. Last scan 2 minutes ago.",
    );
    clearMocks();
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
      return Promise.reject({ code: "index.database", message: "database is locked" });
    });
    await index.load();
    await flushPromises();
    expect(wrapper.get('[data-testid="index-error"]').text()).toContain(
      "The repository list could not be read. The repository list could not be saved. database is locked",
    );
    wrapper.unmount();
  });

  it("renders in Spanish", async () => {
    const index = useIndexStore();
    index.entries = fixture;
    index.loaded = true;
    const wrapper = mountWithI18n(HomeScreen, {}, { locale: "es" });
    await flushPromises();
    expect(wrapper.get('[data-testid="home-summary"]').text()).toBe(
      "4 repositorios y 1 worktree en 2 carpetas. Último escaneo hace 2 minutos.",
    );
    expect(sectionHeaders(wrapper)).toEqual([["Fijados"], ["Recientes"], [CODE, "2"]]);
    wrapper.unmount();
  });
});

describe("useDiscoveryFormat", () => {
  it("names a missing entry and formats the folder status by contents", async () => {
    const index = useIndexStore();
    index.entries = [entry("solo"), entry("gone", { missing: true })];
    index.loaded = true;
    const Probe = defineComponent({
      setup() {
        const format = useDiscoveryFormat();
        return () =>
          h("div", [
            h("p", format.folderStatus(CODE)),
            h("p", format.folderStatus(WT)),
            h("p", format.summary.value),
          ]);
      },
    });
    const wrapper = mountWithI18n(Probe);
    await flushPromises();
    expect(wrapper.findAll("p").map((p) => p.text())).toEqual([
      "2 repositories",
      "no repositories",
      "2 repositories in 2 folders. Last scan 2 minutes ago.",
    ]);
    const home = mountWithI18n(HomeScreen);
    await flushPromises();
    const missing = home
      .findAll('[data-testid="repo-row"]')
      .find((row) => row.get('[data-testid="repo-row-name"]').text() === "gone");
    expect(missing?.get('[data-testid="repo-row-missing"]').text()).toBe("not found");
    expect(missing?.find('[data-testid="repo-row-branch"]').exists()).toBe(false);
    home.unmount();
    wrapper.unmount();
  });
});
