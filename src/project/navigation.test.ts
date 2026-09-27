import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, type ComputedRef } from "vue";

import { usePaletteProjects, usePaletteRepos } from "@/palette/usePaletteActions";
import type { PaletteRepo } from "@/palette/usePalette";
import RepoSwitcher from "@/shell/RepoSwitcher.vue";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useIndexStore } from "@/stores/index";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled } from "@/test/backend";
import { entryOf, projectOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

const GEO = "/home/iker/code/geo";
const api = entryOf(`${GEO}/api`);
const web = entryOf(`${GEO}/web`);
const infra = entryOf(`${GEO}/infra`);
const begitra = entryOf("/home/iker/code/begitra", { pinned: true });
const tiles = entryOf("/home/iker/code/tiles");

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await settled();
}

async function load(): Promise<void> {
  fakeBackend({
    repositories: [begitra, tiles, api, web, infra],
    projects: [
      projectOf(1, "Geoportal", [api.path, web.path, `${GEO}/gone`, infra.path]),
      projectOf(2, "Tiles", [tiles.path]),
    ],
    rootIsPath: true,
  });
  await Promise.all([useProjectsStore().load(), useIndexStore().load()]);
}

/** The palette's Projects and Repos rows, read inside a component as the overlay reads them. */
function paletteRows(): {
  projects: ComputedRef<PaletteRepo[]>;
  repos: ComputedRef<PaletteRepo[]>;
} {
  let projects: ComputedRef<PaletteRepo[]> | undefined;
  let repos: ComputedRef<PaletteRepo[]> | undefined;
  mountWithI18n(
    defineComponent({
      setup() {
        projects = usePaletteProjects();
        repos = usePaletteRepos();
        return () => h("div");
      },
    }),
  );
  if (!projects || !repos) throw new Error("not set up");
  return { projects, repos };
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

describe("moving between a project's repositories", () => {
  it("binds Alt Down and Alt Up to the next and the previous member", () => {
    const registry = new ShortcutRegistry("windows");
    expect(registry.hint("next-project-repo")).toBe("Alt ↓");
    expect(registry.hint("previous-project-repo")).toBe("Alt ↑");
  });

  it("lists the projects in the palette, each opening its Overview", async () => {
    await load();
    const { projects } = paletteRows();
    expect(projects.value.map((row) => [row.name, row.context])).toEqual([
      ["Geoportal", "4 repositories"],
      ["Tiles", "1 repository"],
    ]);
    await projects.value[1]?.run();
    await flush();
    expect(useShellStore().layoutMode).toBe("project");
    expect(useSettingsStore().values.activeProject).toBe(2);
    expect(useSettingsStore().values.projectTab).toBe("overview");
  });

  it("lists the active project's members first in the palette while one is open", async () => {
    await load();
    const { repos } = paletteRows();
    expect(repos.value.map((row) => row.name).slice(0, 1)).toEqual(["begitra"]);
    await useProjectsStore().open(1);
    await useIndexStore().open(web.path);
    await useShellStore().setLayoutMode("graph");
    await flush();
    expect(useRepoStore().repo?.root).toBe(web.path);
    const names = repos.value.map((row) => row.name);
    expect(names.slice(0, 4)).toEqual(["api", "web", "infra", "begitra"]);
    expect(repos.value.slice(0, 3).every((row) => row.featured)).toBe(true);
    // Another repository open, the project's view hidden: the usual order.
    await useIndexStore().open(tiles.path);
    await flush();
    expect(repos.value.map((row) => row.name)[0]).toBe("begitra");
  });

  it("shows the project's members above Pinned in the switcher, the open one marked", async () => {
    await load();
    await useProjectsStore().open(1);
    await useIndexStore().open(web.path);
    await flush();
    const wrapper = mountWithI18n(RepoSwitcher, {
      props: { repositoryName: "web", repositoryRoot: web.path },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="repo-switcher"]').trigger("click");
    await flush();
    const menu = wrapper.get('[data-testid="repo-switcher-menu"]');
    expect(menu.get('[data-testid="switcher-project"]').text()).toBe("Geoportal");
    const paths = menu.findAll("[data-path]").map((item) => item.attributes("data-path"));
    expect(paths.slice(0, 3)).toEqual([api.path, web.path, infra.path]);
    expect(menu.get(`[data-path="${web.path}"]`).attributes("aria-current")).toBe("true");
    wrapper.unmount();
  });
});
