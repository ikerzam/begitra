import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useGraphStore } from "@/stores/graph";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import NotesBlock from "./NotesBlock.vue";
import ReviewFilesPanel from "./ReviewFilesPanel.vue";

beforeEach(() => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
});

afterEach(() => {
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

async function openRepository() {
  const repo = useRepoStore();
  await repo.open("/r");
  await settled();
  return repo;
}

describe("ReviewFilesPanel", () => {
  it("lists the files of the target, filters by path, sorts by size and collapses folders", async () => {
    fakeBackend();
    await openRepository();
    const review = useReviewStore();
    const wrapper = mountWithI18n(ReviewFilesPanel, { attachTo: document.body });
    await flushPromises();
    const names = () =>
      wrapper.findAll('[data-testid="tree-row"][data-path]').map((r) => r.attributes("data-path"));
    // The generated lockfile is hidden by default; the first file opened.
    expect(names()).toEqual(["src/00.rs", "src/lib.ts", "docs/tiles-worker.png"]);
    // A row shows its file's name; its whole path is its tooltip and its description.
    const image = wrapper.get('[data-testid="tree-row"][data-path="docs/tiles-worker.png"]');
    expect(image.attributes("data-tooltip")).toBe("docs/tiles-worker.png");
    expect(image.attributes("aria-description")).toBe("docs/tiles-worker.png");
    expect(review.selectedPath).toBe("src/00.rs");
    expect(wrapper.get('[data-testid="panel-header-count"]').text()).toBe("3");
    await wrapper.get('[data-testid="files-filter"]').trigger("click");
    await nextTick();
    const input = wrapper.get('[data-testid="files-filter-input"]');
    expect(document.activeElement).toBe(input.element);
    await input.setValue("*.ts");
    expect(names()).toEqual(["src/lib.ts"]);
    await input.setValue("zzz");
    expect(wrapper.get('[data-testid="review-empty"]').text()).toBe("No files match the filter.");
    await input.trigger("keydown", { key: "Escape" });
    expect(names()).toHaveLength(3);
    await wrapper.get('[data-testid="files-sort"]').trigger("click");
    expect(names()).toEqual(["src/lib.ts", "src/00.rs", "docs/tiles-worker.png"]);
    await wrapper.get('[data-testid="files-collapse"]').trigger("click");
    expect(names()).toHaveLength(0);
    await wrapper.get('[data-testid="files-collapse"]').trigger("click");
    expect(names()).toHaveLength(3);
    wrapper.unmount();
  });

  it("names the target under the title and moves the open file with moveFile", async () => {
    fakeBackend();
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    const wrapper = mountWithI18n(ReviewFilesPanel, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="review-target"]').text()).toBe("Working tree");
    const panel = wrapper.vm as unknown as { moveFile(step: 1 | -1): void };
    panel.moveFile(1);
    expect(review.selectedPath).toBe("src/lib.ts");
    panel.moveFile(-1);
    panel.moveFile(-1);
    expect(review.selectedPath).toBe("src/working-tree.rs");
    review.setTarget({ kind: "range", from: "v2.3.1", to: "main", threeDot: true });
    await settled();
    await nextTick();
    expect(wrapper.get('[data-testid="review-target"]').text()).toBe("v2.3.1...main");
    wrapper.unmount();
  });

  it("offers a file's history as the target has it: none for a file the working tree adds", async () => {
    fakeBackend();
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    const wrapper = mountWithI18n(ReviewFilesPanel, { attachTo: document.body });
    await flushPromises();
    const menuOn = async (path: string) => {
      await wrapper.get(`[data-testid="tree-row"][data-path="${path}"]`).trigger("contextmenu");
      await flushPromises();
    };
    await menuOn("src/lib.ts");
    expect(wrapper.find('[data-testid="file-menu"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-menu-history"]').exists()).toBe(false);
    await menuOn("src/working-tree.rs");
    await wrapper.get('[data-testid="file-menu-history"]').trigger("click");
    await settled();
    expect(useGraphStore().filters.path).toBe("src/working-tree.rs");
    expect(useShellStore().layoutMode).toBe("graph");
    wrapper.unmount();
  });
});

describe("NotesBlock", () => {
  it("adds, edits and deletes the note of the open file", async () => {
    fakeBackend();
    await openRepository();
    const review = useReviewStore();
    review.select("src/00.rs");
    const wrapper = mountWithI18n(NotesBlock, { attachTo: document.body });
    expect(wrapper.text()).toContain("No notes on this change set yet.");
    const add = wrapper.get('[data-testid="add-note"]');
    expect(add.attributes("aria-label")).toBe("Add note");
    expect(add.text()).toBe("");
    await add.trigger("click");
    await nextTick();
    const editor = wrapper.get('[data-testid="note-editor"] textarea');
    expect(document.activeElement).toBe(editor.element);
    await editor.setValue("Check eviction.");
    await editor.trigger("keydown", { key: "Enter", ctrlKey: true });
    expect(review.notes.get("src/00.rs")).toBe("Check eviction.");
    const note = wrapper.get('[data-testid="note"]');
    expect(note.text()).toContain("src/00.rs");
    expect(note.text()).toContain("Check eviction.");
    expect(wrapper.get('[data-testid="add-note"]').attributes("disabled")).toBeDefined();
    await note.get('[data-testid="delete-note"]').trigger("click");
    expect(review.notes.has("src/00.rs")).toBe(false);
    expect(wrapper.find('[data-testid="note"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
