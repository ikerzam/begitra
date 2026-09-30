import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import type { IndexEntry } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts } from "@/shortcuts/useShortcut";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { folderProjectOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

import { useOpenFolder } from "@/shell/useOpenFolder";

import ProjectLayout from "@/project/ProjectLayout.vue";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const { open: pickFolder } = await import("@tauri-apps/plugin-dialog");

const CODE = "/code";

function entry(name: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path: `${CODE}/${name}`,
    name,
    kind: "main",
    parentPath: null,
    scanRoot: CODE,
    summary: {
      currentBranch: name === "web" ? "feat/tiles" : "main",
      detached: false,
      ahead: 0,
      behind: 0,
      lastCommitAt: 1_704_000_000,
      upstream: null,
      operation: null,
      fetchedAt: null,
      lastCommitSubject: null,
      dirty: false,
    },
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: 1_704_000_100,
    missing: false,
    ...over,
  };
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

const folderRepositories = [entry("api"), entry("infra"), entry("web")];
const folderChanges = {
  "/code/api": { unstaged: [changedFile("src/a.ts"), changedFile("src/b.ts")], staged: [] },
  "/code/web": { unstaged: [changedFile("tiles.ts")], staged: [] },
  "/code/infra": { unstaged: [], staged: [] },
};

/** The folder project of /code, holding api, infra and web as its scans found them. */
const codeProject = folderProjectOf(
  1,
  CODE,
  folderRepositories.map((entry) => entry.path),
);

async function mountFolder(options: FakeBackendOptions = {}) {
  const calls = fakeBackend({
    repositories: folderRepositories,
    projects: [codeProject],
    changesByRepo: folderChanges,
    ...options,
  });
  const [index, projects, settings, shell] = [
    useIndexStore(),
    useProjectsStore(),
    useSettingsStore(),
    useShellStore(),
  ];
  await Promise.all([index.load(), projects.load()]);
  // The folder view is the Changes of a project of several repositories.
  void settings.update("activeProject", 1);
  void shell.setLayoutMode("changes");
  const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
  for (let i = 0; i < 4; i += 1) await settled();
  return { wrapper, calls };
}

const names = (wrapper: ReturnType<typeof mountWithI18n>) =>
  wrapper.findAll('[data-testid="folder-section-name"]').map((name) => name.text());

function row(wrapper: ReturnType<typeof mountWithI18n>, root: string, path: string) {
  return wrapper.get(`[data-root="${root}"] [data-path="${path}"]`);
}

/** The commit box's line: "Commit to", the repository, then its branch. */
const target = (wrapper: ReturnType<typeof mountWithI18n>) =>
  Array.from(wrapper.get('[data-testid="commit-target"]').element.children).map(
    (part) => part.textContent?.trim() ?? "",
  );

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

describe("the folder view's Changes", () => {
  it("shows a section per repository with changes and the others in the group", async () => {
    const { wrapper, calls } = await mountFolder();
    expect(names(wrapper)).toEqual(["api", "web"]);
    const web = wrapper.get('[data-root="/code/web"]');
    expect(web.get('[data-testid="folder-section-branch"]').text()).toBe("feat/tiles");
    // The branch's dot is its lane among the Overview's branch groups: main (two), feat/tiles.
    const lane = (root: string) =>
      wrapper.get(`[data-root="${root}"] [data-lane]`).attributes("data-lane");
    expect([lane("/code/api"), lane("/code/web")]).toEqual(["1", "2"]);
    expect(web.get('[data-testid="folder-section-count"]').text()).toBe("1 file");
    // Its editor opens the repository's folder.
    await web.get('[data-testid="folder-section-editor"]').trigger("click");
    await flushPromises();
    expect(calls.filter((call) => call.cmd === "open_external").at(-1)?.args["path"]).toBe(
      "/code/web",
    );
    // A section shows the lists that hold files.
    expect(web.find('[data-testid="staged-list"]').exists()).toBe(false);
    // The box reads "Commit to" with the repository and its branch.
    expect(target(wrapper)).toEqual(["Commit to", "api", "main"]);
    const group = wrapper.get('[data-testid="folder-group"]');
    expect(group.text()).toContain("1 repository without changes");
    expect(group.get('[data-testid="folder-group-list"]').isVisible()).toBe(false);
    const toggle = wrapper.get('[data-testid="folder-group-toggle"]');
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await toggle.trigger("click");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(wrapper.findAll('[data-testid="folder-group-row"]').map((item) => item.text())).toEqual([
      "infraNo changes",
    ]);
    wrapper.unmount();
  });

  it("carries j and k across the sections, and the box follows the selection", async () => {
    const { wrapper } = await mountFolder();
    const last = row(wrapper, "/code/api", "src/b.ts");
    await last.trigger("click");
    (last.element as HTMLElement).focus();
    await last.trigger("keydown", { key: "j" });
    await flushPromises();
    await nextTick();
    const first = row(wrapper, "/code/web", "tiles.ts");
    expect(first.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(first.element);
    expect(target(wrapper)).toEqual(["Commit to", "web", "feat/tiles"]);
    // The section the selection left marks no row.
    expect(last.attributes("aria-selected")).toBe("false");
    await first.trigger("keydown", { key: "k" });
    await flushPromises();
    await nextTick();
    expect(row(wrapper, "/code/api", "src/b.ts").attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("stages in the section's repository", async () => {
    const { wrapper, calls } = await mountFolder();
    const file = row(wrapper, "/code/web", "tiles.ts");
    await file.trigger("click");
    const uninstall = installShortcuts();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    uninstall();
    for (let i = 0; i < 3; i += 1) await settled();
    expect(of(calls, "stage_paths").at(-1)?.args).toMatchObject({
      repo: "/code/web",
      paths: ["tiles.ts"],
    });
    expect(
      wrapper.find('[data-root="/code/web"] [data-list="staged"][data-path="tiles.ts"]').exists(),
    ).toBe(true);
    wrapper.unmount();
  });

  it("closes a section from its header, and j walks past it", async () => {
    const { wrapper } = await mountFolder({
      repositories: [...folderRepositories, entry("zeta")],
      projects: [
        folderProjectOf(1, CODE, [...folderRepositories.map((e) => e.path), "/code/zeta"]),
      ],
      changesByRepo: {
        ...folderChanges,
        "/code/zeta": { unstaged: [changedFile("z.ts")], staged: [] },
      },
    });
    const toggle = wrapper.get('[data-root="/code/web"] [data-testid="folder-section-toggle"]');
    expect(toggle.attributes("aria-expanded")).toBe("true");
    await toggle.trigger("click");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(wrapper.get('[data-root="/code/web"] [data-testid="change-lists"]').isVisible()).toBe(
      false,
    );
    const last = row(wrapper, "/code/api", "src/b.ts");
    await last.trigger("click");
    (last.element as HTMLElement).focus();
    await last.trigger("keydown", { key: "j" });
    await flushPromises();
    await nextTick();
    expect(row(wrapper, "/code/zeta", "z.ts").attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("walks on from a closed section the selection is in, both ways", async () => {
    const { wrapper } = await mountFolder({
      repositories: [...folderRepositories, entry("zeta")],
      projects: [
        folderProjectOf(1, CODE, [...folderRepositories.map((e) => e.path), "/code/zeta"]),
      ],
      changesByRepo: {
        ...folderChanges,
        "/code/zeta": { unstaged: [changedFile("z.ts")], staged: [] },
      },
    });
    await row(wrapper, "/code/web", "tiles.ts").trigger("click");
    await wrapper
      .get('[data-root="/code/web"] [data-testid="folder-section-toggle"]')
      .trigger("click");
    const uninstall = installShortcuts();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    await flushPromises();
    await nextTick();
    expect(row(wrapper, "/code/zeta", "z.ts").attributes("aria-selected")).toBe("true");
    // Back past the closed section, onto the last row of the one before it.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    await flushPromises();
    await nextTick();
    uninstall();
    expect(row(wrapper, "/code/api", "src/b.ts").attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("names the repository in the discard confirmation", async () => {
    const { wrapper } = await mountFolder();
    await row(wrapper, "/code/web", "tiles.ts").trigger("click");
    const uninstall = installShortcuts();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    uninstall();
    await nextTick();
    expect(wrapper.get('[data-testid="discard-dialog"]').text()).toContain(
      "Discard 1 file in web?",
    );
    wrapper.unmount();
  });

  it("shows a folder whose repositories are gone with Scan again, and one with nothing to commit", async () => {
    const empty = await mountFolder({ repositories: [] });
    expect(empty.wrapper.get('[data-testid="folder-empty"]').text()).toContain(
      "No repositories in code.",
    );
    await empty.wrapper.get('[data-testid="folder-scan-again"]').trigger("click");
    expect(of(empty.calls, "scan_folders").at(-1)?.args["folders"]).toEqual([CODE]);
    empty.wrapper.unmount();
    setActivePinia(createPinia());
    await useSettingsStore().init(memoryStorage(), "windows");
    const clean = await mountFolder({
      repositories: [entry("infra"), entry("api")],
      projects: [folderProjectOf(1, CODE, ["/code/api", "/code/infra"])],
      changesByRepo: {
        "/code/infra": { unstaged: [], staged: [] },
        "/code/api": { unstaged: [], staged: [] },
      },
    });
    expect(clean.wrapper.get('[data-testid="folder-clean"]').text()).toContain(
      "Nothing to commit in 2 repositories",
    );
    expect(clean.wrapper.find('[data-testid="commit-box"]').exists()).toBe(false);
    clean.wrapper.unmount();
  });
});

describe("a list project's Changes", () => {
  it("names the project and offers Edit project… when none of its repositories is there", async () => {
    const { wrapper } = await mountFolder({
      repositories: [],
      projects: [
        {
          ...folderProjectOf(1, CODE, []),
          kind: "list",
          folder: null,
          name: "Geoportal",
          members: [
            { path: "/code/a", origin: "hand" },
            { path: "/code/b", origin: "hand" },
          ],
        },
      ],
    });
    expect(wrapper.get('[data-testid="folder-empty"]').text()).toContain(
      "No repositories in Geoportal.",
    );
    expect(wrapper.find('[data-testid="folder-scan-again"]').exists()).toBe(false);
    await wrapper.get('[data-testid="folder-edit-project"]').trigger("click");
    expect(useProjectDialogsStore().editing).toBe(1);
    wrapper.unmount();
  });
});

describe("opening a folder of repositories", () => {
  it("makes the picked folder that is not a repository a folder project, and scans it", async () => {
    const calls = fakeBackend({ notRepositories: ["/code"], repositories: folderRepositories });
    vi.mocked(pickFolder).mockResolvedValue("/code");
    let run: () => Promise<string | null> = () => Promise.resolve(null);
    const Host = defineComponent({
      setup() {
        run = useOpenFolder().openFolder;
        return () => h("div");
      },
    });
    const host = mountWithI18n(Host);
    expect(await run()).toBe("/code");
    await settled();
    const projects = useProjectsStore();
    expect(projects.active?.kind).toBe("folder");
    expect(projects.active?.folder).toBe("/code");
    expect(useShellStore().layoutMode).toBe("graph");
    expect(of(calls, "scan_folders").at(-1)?.args["folders"]).toEqual(["/code"]);
    host.unmount();
  });
});
