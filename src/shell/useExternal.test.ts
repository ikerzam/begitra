import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useToastsStore } from "@/stores/toasts";
import { fakeBackend } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import { useExternal } from "./useExternal";

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

function mountExternal() {
  const wrapper = mountWithI18n({
    template: "<div />",
    setup() {
      return useExternal();
    },
  });
  return { wrapper, external: wrapper.vm as unknown as ReturnType<typeof useExternal> };
}

describe("useExternal", () => {
  it("opens a file of a working tree at a line with the editor's at-line form first", async () => {
    const calls = fakeBackend();
    const { wrapper, external } = mountExternal();
    const ok = await external.openFile(String.raw`C:\geo`, "src/map/worker-pool.ts", 42);
    expect(useToastsStore().toasts.map((toast) => [toast.message, toast.output])).toEqual([]);
    expect(ok).toBe(true);
    const opened = calls.find((call) => call.cmd === "open_external");
    expect(opened?.args).toEqual({
      templates: ["code.cmd -g {path}:{line}", "code.cmd {path}"],
      path: String.raw`C:\geo\src\map\worker-pool.ts`,
      line: 42,
    });
    // Without a line the editor's templates open the file as they open a folder.
    await external.openFile(String.raw`C:\geo`, "README.md");
    const plain = calls.filter((call) => call.cmd === "open_external").at(-1);
    expect(plain?.args).toEqual({
      templates: ["code.cmd {path}"],
      path: String.raw`C:\geo\README.md`,
      line: null,
    });
    wrapper.unmount();
  });

  it("takes Editor at a line before anything it derives", async () => {
    const calls = fakeBackend();
    await useSettingsStore().update("editorLineCommand", "idea64.exe --line {line} {path}");
    const { wrapper, external } = mountExternal();
    await external.openFile("/r", "a.ts", 7);
    const opened = calls.find((call) => call.cmd === "open_external");
    expect((opened?.args as { templates: string[] }).templates[0]).toBe(
      "idea64.exe --line {line} {path}",
    );
    wrapper.unmount();
  });

  it("names a file that is not on disk instead of starting anything", async () => {
    fakeBackend({ missingPaths: ["/r/src/old/tiles.ts"] });
    const { wrapper, external } = mountExternal();
    expect(await external.openFile("/r", "src/old/tiles.ts", 3)).toBe(false);
    await flushPromises();
    const toasts = useToastsStore();
    expect(toasts.toasts).toHaveLength(1);
    expect(toasts.toasts[0]?.message).toBe("src/old/tiles.ts is not on disk.");
    expect(toasts.toasts[0]?.output).toBeUndefined();
    wrapper.unmount();
  });
});
