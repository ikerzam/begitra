import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useToastsStore } from "@/stores/toasts";
import { fakeBackend, settled } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import FileList from "./FileList.vue";
import FileMenu from "./FileMenu.vue";

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

describe("FileList", () => {
  it("asks for a file's menu on a right click and on the menu key, taking the webview's", async () => {
    const files = [changedFile("src/map/worker-pool.ts")];
    const wrapper = mountWithI18n(FileList, { props: { files }, attachTo: document.body });
    const row = wrapper.get('[data-path="src/map/worker-pool.ts"]');
    const click = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    });
    row.element.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(wrapper.emitted("menu")?.[0]).toEqual([files[0], 30, 40]);
    await row.trigger("keydown", { key: "ContextMenu" });
    await row.trigger("keydown", { key: "F10", shiftKey: true });
    expect(wrapper.emitted("menu")).toHaveLength(3);
    wrapper.unmount();
  });
});

describe("FileMenu", () => {
  it("copies the path with a toast, opens the file in the editor and offers review when asked", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const calls = fakeBackend();
    await useRepoStore().open("/r");
    await settled();
    const file = changedFile("src/map/worker-pool.ts");
    const wrapper = mountWithI18n(FileMenu, {
      props: { file, x: 10, y: 20, review: true },
      attachTo: document.body,
    });
    expect(wrapper.findAll("[role='menuitem']").map((item) => item.text())).toEqual([
      "Open in review",
      "Copy path",
      "Open in editor",
    ]);
    await wrapper.get('[data-testid="file-menu-review"]').trigger("click");
    expect(wrapper.emitted("review")?.[0]).toEqual([file]);
    await wrapper.get('[data-testid="file-menu-copy"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("src/map/worker-pool.ts");
    expect(useToastsStore().toasts.at(-1)?.message).toBe("Path src/map/worker-pool.ts copied");
    await wrapper.get('[data-testid="file-menu-editor"]').trigger("click");
    await flushPromises();
    const opened = calls.filter((call) => call.cmd === "open_external").at(-1);
    expect(opened?.args["path"]).toBe("/r/src/map/worker-pool.ts");
    wrapper.unmount();
  });

  it("offers no review from the review itself and nothing to open for a deleted file", () => {
    fakeBackend();
    const wrapper = mountWithI18n(FileMenu, {
      props: { file: changedFile("old.ts", { status: "deleted" }), x: 0, y: 0 },
    });
    expect(wrapper.find('[data-testid="file-menu-review"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="file-menu-editor"]').attributes("aria-disabled")).toBe(
      "true",
    );
    wrapper.unmount();
  });
});
