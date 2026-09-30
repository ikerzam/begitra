import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, type ComputedRef } from "vue";

import { usePaletteProjects, usePaletteRepos } from "@/palette/usePaletteActions";
import type { PaletteRepo } from "@/palette/usePalette";
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
const begitra = entryOf("/home/iker/code/begitra");
const tiles = entryOf("/home/iker/code/tiles");

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await settled();
}

async function load(): Promise<void> {
  fakeBackend({
    repositories: [begitra, tiles, api, web, infra],
    projects: [
      projectOf(1, "Geoportal", [api.path, web.path, `${GEO}/gone`, infra.path], {
        openedAt: 20,
      }),
      projectOf(2, "Tiles", [tiles.path], { openedAt: 30 }),
      projectOf(3, "Begitra", [begitra.path]),
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

  it("lists the projects in the palette, the recent ones while the query is empty, each opening it", async () => {
    await load();
    const { projects } = paletteRows();
    expect(projects.value.map((row) => [row.name, row.context, row.featured])).toEqual([
      ["Begitra", "1 repository", false],
      ["Geoportal", "4 repositories", true],
      ["Tiles", "1 repository", true],
    ]);
    await projects.value[2]?.run();
    await flush();
    expect(useShellStore().layoutMode).toBe("graph");
    expect(useSettingsStore().values.activeProject).toBe(2);
    expect(useRepoStore().repo?.root).toBe(tiles.path);
  });

  it("lists every project's repositories in the palette, the open project's first, each with its project", async () => {
    await load();
    const { repos } = paletteRows();
    await useProjectsStore().open(1, web.path);
    await flush();
    expect(useRepoStore().repo?.root).toBe(web.path);
    expect(repos.value.map((row) => [row.name, row.context, row.featured])).toEqual([
      ["api", "Geoportal", true],
      ["web", "Geoportal", true],
      ["infra", "Geoportal", true],
      ["begitra", "Begitra", false],
      ["tiles", "Tiles", false],
    ]);
    // A repository of another project opens that project, showing it.
    await repos.value[4]?.run();
    await flush();
    expect(useProjectsStore().active?.name).toBe("Tiles");
    expect(useRepoStore().repo?.root).toBe(tiles.path);
  });

  it("shows the next and the previous present member with Alt Down and Alt Up", async () => {
    await load();
    const projects = useProjectsStore();
    await projects.open(1);
    await flush();
    expect(useRepoStore().repo?.root).toBe(api.path);
    await projects.openNeighbour(1);
    await flush();
    expect(useRepoStore().repo?.root).toBe(web.path);
    // The missing member is skipped.
    await projects.openNeighbour(1);
    await flush();
    expect(useRepoStore().repo?.root).toBe(infra.path);
    await projects.openNeighbour(1);
    await flush();
    expect(useRepoStore().repo?.root).toBe(api.path);
    await projects.openNeighbour(-1);
    await flush();
    expect(useRepoStore().repo?.root).toBe(infra.path);
    expect(projects.active?.lastRepository).toBe(infra.path);
  });
});
