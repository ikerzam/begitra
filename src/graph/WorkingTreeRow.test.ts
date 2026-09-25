import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useChangesStore } from "@/stores/changes";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import WorkingTreeRow from "./WorkingTreeRow.vue";

/** Sets the lists of the changes store to files at these paths. */
function lists(unstaged: string[], staged: string[]): void {
  const changes = useChangesStore();
  changes.unstaged = { ...changes.unstaged, files: unstaged.map((path) => changedFile(path)) };
  changes.staged = { ...changes.staged, files: staged.map((path) => changedFile(path)) };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("WorkingTreeRow", () => {
  it("shows nothing while both lists are empty, loading or clean", () => {
    const wrapper = mountWithI18n(WorkingTreeRow);
    expect(wrapper.find('[data-testid="working-tree-row"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("names the uncommitted changes with both counts and opens the changes screen", async () => {
    lists(["a.ts", "b.ts"], ["c.ts"]);
    const wrapper = mountWithI18n(WorkingTreeRow);
    const row = wrapper.get('[data-testid="working-tree-row"]');
    expect(row.element.tagName).toBe("BUTTON");
    expect(row.text()).toContain("Uncommitted changes");
    expect(wrapper.get('[data-testid="working-tree-counts"]').text()).toBe("2 unstaged · 1 staged");
    await row.trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
    wrapper.unmount();
  });

  it("leaves a count of zero out, and follows the lists", async () => {
    lists([], ["c.ts"]);
    const wrapper = mountWithI18n(WorkingTreeRow);
    expect(wrapper.get('[data-testid="working-tree-counts"]').text()).toBe("1 staged");
    lists([], []);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="working-tree-row"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders in Spanish", () => {
    lists(["a.ts", "b.ts"], ["c.ts"]);
    const wrapper = mountWithI18n(WorkingTreeRow, {}, { locale: "es" });
    expect(wrapper.text()).toContain("Cambios sin confirmar");
    expect(wrapper.get('[data-testid="working-tree-counts"]').text()).toBe(
      "2 sin preparar · 1 preparado",
    );
    wrapper.unmount();
  });
});
