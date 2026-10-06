import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChangesStore } from "@/stores/changes";
import { useGraphStore } from "@/stores/graph";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
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
      "File history",
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

  it("shows the file's history in the graph, a commit's rename under its new path", async () => {
    const calls = fakeBackend();
    await useRepoStore().open("/r");
    await settled();
    const file = changedFile("src/map/pool.ts", { status: "renamed", oldPath: "src/pool.ts" });
    const wrapper = mountWithI18n(FileMenu, { props: { file, x: 0, y: 0 } });
    await wrapper.get('[data-testid="file-menu-history"]').trigger("click");
    await settled();
    expect(useGraphStore().filters.path).toBe("src/map/pool.ts");
    expect(useShellStore().layoutMode).toBe("graph");
    const walk = calls.filter((call) => call.cmd === "walk_commits").at(-1);
    expect((walk?.args["options"] as { filter?: unknown }).filter).toEqual({
      paths: ["src/map/pool.ts"],
    });
    wrapper.unmount();
  });

  it("lists a change not committed yet under the path behind it, and offers none for a new file", async () => {
    const renamed = changedFile("src/map/pool.ts", { status: "renamed", oldPath: "src/pool.ts" });
    fakeBackend({ changes: { unstaged: [], staged: [renamed] } });
    // The shell keeps the open repository's lists, as the top bar counts them.
    const changes = useChangesStore();
    await useRepoStore().open("/r");
    await settled();
    await settled();
    expect(changes.staged.files.map((file) => file.path)).toEqual(["src/map/pool.ts"]);
    const wrapper = mountWithI18n(FileMenu, {
      props: { file: renamed, x: 0, y: 0, side: "index" },
    });
    await wrapper.get('[data-testid="file-menu-history"]').trigger("click");
    await settled();
    expect(useGraphStore().filters.path).toBe("src/pool.ts");
    wrapper.unmount();
    // The working tree's edit of the renamed file goes through the index's rename.
    const edited = mountWithI18n(FileMenu, {
      props: { file: changedFile("src/map/pool.ts"), x: 0, y: 0, side: "worktree" },
    });
    await edited.get('[data-testid="file-menu-history"]').trigger("click");
    await settled();
    expect(useGraphStore().filters.path).toBe("src/pool.ts");
    edited.unmount();
    const added = mountWithI18n(FileMenu, {
      props: { file: changedFile("src/new.ts", { status: "added" }), x: 0, y: 0, side: "index" },
    });
    expect(added.find('[data-testid="file-menu-history"]').exists()).toBe(false);
    added.unmount();
  });
});
