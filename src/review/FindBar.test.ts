import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts } from "@/shortcuts/useShortcut";
import ReviewFocusLayout from "@/shell/ReviewFocusLayout.vue";
import { useFindStore } from "@/stores/find";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { fakeBackend, settled } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

let uninstall: () => void = () => {};

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  uninstall = installShortcuts(window);
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  uninstall();
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

/** Review focus on the working tree's change set: src/working-tree.rs, src/lib.ts, an image. */
async function mountReview(): Promise<VueWrapper> {
  fakeBackend();
  await useRepoStore().open("/r");
  await settled();
  useReviewStore().setTarget({ kind: "worktree" });
  await settled();
  const wrapper = mountWithI18n(ReviewFocusLayout, { attachTo: document.body });
  await settled();
  await measure(wrapper);
  return wrapper;
}

/** A 200px diff body jsdom cannot measure. */
async function measure(wrapper: VueWrapper): Promise<void> {
  const body = wrapper.find('[data-testid="diff-body"]');
  if (!body.exists()) return;
  Object.defineProperty(body.element, "clientHeight", { value: 200, configurable: true });
  Object.defineProperty(body.element, "clientWidth", { value: 800, configurable: true });
  await body.trigger("scroll");
}

/** The current match's text, which the syntax colours may cut into several spans. */
function currentText(wrapper: VueWrapper): string {
  return wrapper
    .findAll(".bg-find-current")
    .map((span) => span.text())
    .join("");
}

/** Lets the count run (it waits for nothing when the bar opens on a query). */
async function counted(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushPromises();
  await nextTick();
}

describe("FindBar in review focus", () => {
  it("counts over the files panel's files and moves between them with ↵ and ⇧↵", async () => {
    const wrapper = await mountReview();
    const review = useReviewStore();
    const find = useFindStore();
    expect(review.selectedPath).toBe("src/working-tree.rs");
    find.show("NEW()");
    await counted();
    const bar = wrapper.get('[data-testid="find-bar"]');
    const field = bar.get("input").element as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("NEW()");
    expect(bar.get('[data-testid="find-count"]').text()).toBe("1 of 2");
    expect(currentText(wrapper)).toBe("new()");
    await bar.get("input").trigger("keydown", { key: "Enter" });
    await counted();
    expect(review.selectedPath).toBe("src/lib.ts");
    expect(bar.get('[data-testid="find-count"]').text()).toBe("2 of 2");
    await bar.get("input").trigger("keydown", { key: "Enter", shiftKey: true });
    await counted();
    expect(review.selectedPath).toBe("src/working-tree.rs");
    // "Match case" leaves nothing of the upper-case query.
    await bar.get('[data-testid="find-match-case"]').trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await counted();
    expect(bar.get('[data-testid="find-count"]').text()).toBe("No results");
    expect(bar.get('[data-testid="find-next"]').attributes("disabled")).toBeDefined();
    // Escape closes the bar and gives the focus to the diff's rows.
    await bar.get("input").trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(wrapper.find('[data-testid="find-bar"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('[data-testid="diff-body"]').element);
    wrapper.unmount();
  });

  it("shows a generated file's lines when a match opens it, as Show anyway does", async () => {
    const wrapper = await mountReview();
    const review = useReviewStore();
    review.setFilter("hideGenerated", false);
    review.setFilter("hideLockfiles", false);
    await settled();
    const find = useFindStore();
    find.show("more()");
    await counted();
    const count = () => wrapper.get('[data-testid="find-count"]').text();
    expect(count()).toBe("1 of 3");
    find.next();
    find.next();
    await counted();
    expect(review.selectedPath).toBe("pnpm-lock.yaml");
    expect(count()).toBe("3 of 3");
    expect(wrapper.find('[data-testid="diff-guard"]').exists()).toBe(false);
    expect(currentText(wrapper)).toBe("more()");
    wrapper.unmount();
  });

  it("closes when the layout leaves, and F3 opens it again on its last query", async () => {
    const wrapper = await mountReview();
    const find = useFindStore();
    find.show("new()");
    await counted();
    wrapper.unmount();
    expect(find.open).toBe(false);
    const again = mountWithI18n(ReviewFocusLayout, { attachTo: document.body });
    await settled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F3" }));
    await counted();
    expect(again.get('[data-testid="find-bar"] input').element).toHaveProperty("value", "new()");
    expect(again.get('[data-testid="find-count"]').text()).toBe("1 of 2");
    again.unmount();
  });
});
