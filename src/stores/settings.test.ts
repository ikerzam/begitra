import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { defaultSettings, memoryStorage, platformDefaults, useSettingsStore } from "./settings";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("settings store", () => {
  it("starts from platform defaults", () => {
    expect(platformDefaults("windows").terminal).toEqual(["wt -d {path}", "cmd /K cd /d {path}"]);
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
    await store.update("terminalCommand", "alacritty --working-directory {path}");
    await store.update("paneSizes", { sidebar: 240, detail: 520, files: 280, reviewRail: 280 });
    expect(storage.data.get("terminalCommand")).toBe("alacritty --working-directory {path}");
    expect(storage.saved).toBe(2);
    expect(store.terminalTemplates).toEqual([
      "alacritty --working-directory {path}",
      "wt -d {path}",
      "cmd /K cd /d {path}",
    ]);
    expect(store.editorTemplates).toEqual(["code {path}"]);

    const relaunched = useSettingsStore();
    setActivePinia(createPinia());
    const fresh = useSettingsStore();
    await fresh.init(storage, "windows");
    expect(fresh.values.paneSizes.detail).toBe(520);
    expect(relaunched.values.paneSizes.detail).toBe(520);
  });

  it("does not fail updates before init", async () => {
    const store = useSettingsStore();
    await store.update("locale", "es");
    expect(store.values.locale).toBe("es");
  });
});
