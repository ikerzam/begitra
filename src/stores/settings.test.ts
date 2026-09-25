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

  it("starts discovery with no scan folders, the default skip list, depth 2 and no last repository", () => {
    const defaults = defaultSettings("linux");
    expect(defaults.scanRoots).toEqual([]);
    expect(defaults.skipFolders).toEqual(defaultSkipFolders);
    expect(defaults.skipFolders).toContain("node_modules");
    expect(defaults.maxDepth).toBe(2);
    expect(defaults.lastRepository).toBeNull();
    expect(defaults.lastScanAt).toBeNull();
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

  it("keeps stored discovery keys that are valid and drops the rest", async () => {
    const store = useSettingsStore();
    await store.init(
      memoryStorage({
        scanRoots: ["/home/iker/code", "/home/iker/wt"],
        skipFolders: "node_modules",
        maxDepth: 99,
        lastRepository: "/home/iker/code/geoportal",
        lastScanAt: 1_704_070_000,
      }),
      "linux",
    );
    expect(store.values.scanRoots).toEqual(["/home/iker/code", "/home/iker/wt"]);
    expect(store.values.skipFolders).toEqual(defaultSkipFolders);
    expect(store.values.maxDepth).toBe(2);
    expect(store.values.lastRepository).toBe("/home/iker/code/geoportal");
    expect(store.values.lastScanAt).toBe(1_704_070_000);

    setActivePinia(createPinia());
    const invalid = useSettingsStore();
    await invalid.init(
      memoryStorage({ scanRoots: ["", 3], maxDepth: 0, lastRepository: 12 }),
      "linux",
    );
    expect(invalid.values.scanRoots).toEqual([]);
    expect(invalid.values.maxDepth).toBe(0);
    expect(invalid.values.lastRepository).toBeNull();
  });

  it("writes the last repository through and clears it with null", async () => {
    const store = useSettingsStore();
    const storage = memoryStorage();
    await store.init(storage, "windows");
    await persisted(store.update("lastRepository", "C:\code\begitra"));
    expect(storage.data.get("lastRepository")).toBe("C:\code\begitra");
    await persisted(store.update("lastRepository", null));
    expect(storage.data.get("lastRepository")).toBeNull();
  });

  it("overlays stored values and ignores invalid ones", async () => {
    const store = useSettingsStore();
    await store.init(
      memoryStorage({
        paneSizes: { sidebar: 240, detail: 520, files: 280, reviewRail: 280 },
        layoutMode: "banana",
        locale: "es",
        terminalCommand: "",
      }),
      "windows",
    );
    expect(store.loaded).toBe(true);
    expect(store.values.paneSizes.detail).toBe(520);
    expect(store.values.layoutMode).toBe("graph");
    expect(store.values.locale).toBe("es");
    expect(store.values.terminalCommand).toBe("wt -d {path}");
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
