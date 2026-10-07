import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSkipFolders } from "@/ipc/commands";

import {
  defaultSettings,
  FLUSH_DELAY_MS,
  memoryStorage,
  platformDefaults,
  useSettingsStore,
} from "./settings";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Awaits `work` while the write timer of the store runs. */
async function persisted(work: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
  await work;
}

describe("settings store", () => {
  it("starts from platform defaults", () => {
    expect(platformDefaults("windows").terminal).toEqual(["wt -d {path}", "cmd /K"]);
    expect(platformDefaults("windows").editor).toEqual(["code.cmd {path}"]);
    expect(platformDefaults("macos").terminal).toEqual(["open -a Terminal {path}"]);
    expect(platformDefaults("linux").terminal).toEqual([
      "x-terminal-emulator --working-directory={path}",
    ]);
    expect(defaultSettings("linux").editorCommand).toBe("code {path}");
    expect(defaultSettings("windows").paneSizes).toEqual({
      sidebar: 240,
      detail: null,
      files: 280,
      reviewRail: 280,
    });
  });

  it("starts discovery with the default skip list, depth 2, no open project and no scan yet", () => {
    const defaults = defaultSettings("linux");
    expect(defaults.skipFolders).toEqual(defaultSkipFolders);
    expect(defaults.skipFolders).toContain("node_modules");
    expect(defaults.maxDepth).toBe(2);
    expect(defaults.activeProject).toBeNull();
    expect(defaults.lastScanAt).toBeNull();
    expect(Object.keys(defaults)).not.toContain("scanRoots");
  });

  it("starts with the design's fonts at their weights, and keeps valid stored fonts only", async () => {
    const defaults = defaultSettings("windows");
    expect([defaults.uiFont, defaults.uiWeight, defaults.codeFont, defaults.codeWeight]).toEqual([
      "",
      "regular",
      "",
      "regular",
    ]);
    const store = useSettingsStore();
    await store.init(
      memoryStorage({
        uiFont: "Segoe UI",
        uiWeight: "heavy",
        codeFont: "x".repeat(65),
        codeWeight: "semibold",
      }),
      "windows",
    );
    expect(store.values.uiFont).toBe("Segoe UI");
    expect(store.values.uiWeight).toBe("regular");
    expect(store.values.codeFont).toBe("");
    expect(store.values.codeWeight).toBe("semibold");
  });

  it("starts at 100% zoom and keeps a stored level only when it is one of the steps", async () => {
    expect(defaultSettings("windows").zoom).toBe(100);
    const store = useSettingsStore();
    await store.init(memoryStorage({ zoom: 133 }), "windows");
    expect(store.values.zoom).toBe(100);
    setActivePinia(createPinia());
    const again = useSettingsStore();
    await again.init(memoryStorage({ zoom: 125 }), "windows");
    expect(again.values.zoom).toBe(125);
  });

  it("shows file icons by default, and keeps them off once turned off", async () => {
    expect(defaultSettings("windows").fileIcons).toBe(true);
    const store = useSettingsStore();
    await store.init(memoryStorage({ fileIcons: false }), "windows");
    expect(store.values.fileIcons).toBe(false);
    setActivePinia(createPinia());
    const invalid = useSettingsStore();
    await invalid.init(memoryStorage({ fileIcons: "yes" }), "windows");
    expect(invalid.values.fileIcons).toBe(true);
  });

  it("ignores a stored Push after commit, which no longer exists", async () => {
    const store = useSettingsStore();
    await store.init(memoryStorage({ pushAfterCommit: true, fileIcons: false }), "windows");
    expect(store.values).not.toHaveProperty("pushAfterCommit");
    expect(store.values.fileIcons).toBe(false);
  });

  it("folds the remote branches and the tags by default, and keeps the sidebar's folds", async () => {
    expect(defaultSettings("windows").sidebarFolded).toEqual(["remote", "tags"]);
    const store = useSettingsStore();
    await store.init(memoryStorage({ sidebarFolded: ["local", "worktrees"] }), "windows");
    expect(store.values.sidebarFolded).toEqual(["local", "worktrees"]);
    setActivePinia(createPinia());
    const invalid = useSettingsStore();
    await invalid.init(memoryStorage({ sidebarFolded: ["branches"] }), "windows");
    expect(invalid.values.sidebarFolded).toEqual(["remote", "tags"]);
  });

  it("keeps stored discovery keys that are valid and drops the rest", async () => {
    const store = useSettingsStore();
    await store.init(
      memoryStorage({ skipFolders: "node_modules", maxDepth: 99, lastScanAt: 1_704_070_000 }),
      "linux",
    );
    expect(store.values.skipFolders).toEqual(defaultSkipFolders);
    expect(store.values.maxDepth).toBe(2);
    expect(store.values.lastScanAt).toBe(1_704_070_000);

    setActivePinia(createPinia());
    const kept = useSettingsStore();
    await kept.init(memoryStorage({ skipFolders: ["target"], maxDepth: 0 }), "linux");
    expect(kept.values.skipFolders).toEqual(["target"]);
    expect(kept.values.maxDepth).toBe(0);
  });

  it("reads the keys of a version before projects once, into legacy, and drops them after", async () => {
    const store = useSettingsStore();
    const storage = memoryStorage({
      scanRoots: ["/home/iker/code", "", 3],
      lastRepository: "/home/iker/code/geoportal",
      folderView: null,
      projectTab: "changes",
    });
    await store.init(storage, "linux");
    // A list with an invalid folder falls back as a whole, as a setting does.
    expect(store.legacy).toEqual({
      scanRoots: [],
      lastRepository: "/home/iker/code/geoportal",
      folderView: null,
      layoutMode: null,
    });
    await store.dropLegacy();
    expect(store.legacy).toBeNull();
    for (const key of ["scanRoots", "lastRepository", "folderView", "projectTab"]) {
      expect(storage.data.has(key)).toBe(false);
    }

    setActivePinia(createPinia());
    const again = useSettingsStore();
    await again.init(storage, "linux");
    expect(again.legacy).toBeNull();
  });

  it("maps the project view to the Overview and the folder view to the Changes, once", async () => {
    const store = useSettingsStore();
    const storage = memoryStorage({
      layoutMode: "folder",
      folderView: "/home/iker/code/geo",
      activeProject: 3,
    });
    await store.init(storage, "windows");
    expect(store.values.layoutMode).toBe("changes");
    expect(store.values.activeProject).toBe(3);
    expect(store.legacy).toEqual({
      scanRoots: [],
      lastRepository: null,
      folderView: "/home/iker/code/geo",
      layoutMode: "folder",
    });
    // The mapped layout is written through at once, so the file keeps no retired layout.
    expect(storage.data.get("layoutMode")).toBe("changes");

    setActivePinia(createPinia());
    const project = useSettingsStore();
    await project.init(memoryStorage({ layoutMode: "project" }), "windows");
    expect(project.values.layoutMode).toBe("overview");
    expect(project.legacy?.layoutMode).toBe("project");
  });

  it("overlays stored values and ignores invalid ones", async () => {
    const store = useSettingsStore();
    await store.init(
      memoryStorage({
        paneSizes: { sidebar: 240, detail: 520, files: 280, reviewRail: 280 },
        layoutMode: "banana",
        activeProject: 1.5,
        locale: "es",
        terminalCommand: "",
        theme: "monokai",
        codeTheme: "one-dark",
      }),
      "windows",
    );
    expect(store.loaded).toBe(true);
    // An unknown theme falls back; a known one is kept.
    expect(store.values.theme).toBe("system");
    expect(store.values.codeTheme).toBe("one-dark");
    expect(store.values.paneSizes.detail).toBe(520);
    expect(store.values.layoutMode).toBe("graph");
    expect(store.values.activeProject).toBeNull();
    expect(store.values.locale).toBe("es");
    expect(store.values.terminalCommand).toBe("wt -d {path}");
  });

  it("keeps the Overview and its project", async () => {
    const store = useSettingsStore();
    await store.init(memoryStorage({ layoutMode: "overview", activeProject: 3 }), "windows");
    expect(store.values.layoutMode).toBe("overview");
    expect(store.values.activeProject).toBe(3);
    expect(store.legacy).toBeNull();
  });

  it("writes updates through and keeps the fallbacks after the configured command", async () => {
    const store = useSettingsStore();
    const storage = memoryStorage();
    await store.init(storage, "windows");
    await persisted(store.update("terminalCommand", "alacritty --working-directory {path}"));
    await persisted(
      store.update("paneSizes", { sidebar: 240, detail: 520, files: 280, reviewRail: 280 }),
    );
    expect(storage.data.get("terminalCommand")).toBe("alacritty --working-directory {path}");
    expect(storage.saved).toBe(2);
    expect(store.terminalTemplates).toEqual([
      "alacritty --working-directory {path}",
      "wt -d {path}",
      "cmd /K",
    ]);
    expect(store.editorTemplates).toEqual(["code.cmd {path}"]);

    const relaunched = useSettingsStore();
    setActivePinia(createPinia());
    const fresh = useSettingsStore();
    await fresh.init(storage, "windows");
    expect(fresh.values.paneSizes.detail).toBe(520);
    expect(relaunched.values.paneSizes.detail).toBe(520);
  });

  it("keeps an update made before init and writes it once the storage is there", async () => {
    const store = useSettingsStore();
    const storage = memoryStorage({ locale: "en", sidebarCollapsed: true });
    await store.update("locale", "es");
    expect(store.values.locale).toBe("es");
    await store.init(storage, "windows");
    expect(store.values.locale).toBe("es");
    expect(store.values.sidebarCollapsed).toBe(true);
    expect(storage.data.get("locale")).toBe("es");
    expect(storage.saved).toBe(1);
  });

  it("coalesces a burst of updates into one write", async () => {
    const store = useSettingsStore();
    const storage = memoryStorage();
    await store.init(storage, "windows");
    const sizes = (detail: number) => ({ sidebar: 240, detail, files: 280, reviewRail: 280 });
    let last: Promise<void> = Promise.resolve();
    for (let px = 400; px <= 520; px += 1) last = store.update("paneSizes", sizes(px));
    expect(storage.saved).toBe(0);
    await persisted(last);
    expect(storage.saved).toBe(1);
    expect(storage.data.get("paneSizes")).toEqual(sizes(520));
  });
});
