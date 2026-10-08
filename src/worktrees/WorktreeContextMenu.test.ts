import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import type { WorktreeRow } from "@/stores/worktrees";
import { mountWithI18n } from "@/test/mount";

import WorktreeContextMenu from "./WorktreeContextMenu.vue";

const gone: WorktreeRow = {
  path: "C:/code/r-feature",
  name: "r-feature",
  branch: "feature",
  head: null,
  detached: false,
  isMain: false,
  locked: false,
  lockReason: null,
  prunable: true,
  bare: false,
  dirty: null,
  lastCommitAt: null,
  lastSubject: null,
  ahead: null,
  behind: null,
};

describe("WorktreeContextMenu", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("disables Terminal and Editor for a folder that is gone in the sidebar only", () => {
    const sidebar = mountWithI18n(WorktreeContextMenu, {
      props: { row: gone, x: 0, y: 0, dialogs: false },
    });
    for (const id of ["menu-terminal", "menu-editor"]) {
      expect(sidebar.get(`[data-testid="${id}"]`).attributes("aria-disabled")).toBe("true");
    }
    sidebar.unmount();
    // The dashboard keeps them: its banner says the folder is gone and offers the prune.
    const dashboard = mountWithI18n(WorktreeContextMenu, {
      props: { row: gone, x: 0, y: 0 },
    });
    for (const id of ["menu-terminal", "menu-editor"]) {
      expect(dashboard.get(`[data-testid="${id}"]`).attributes("aria-disabled")).toBeUndefined();
    }
    // A folder that is gone has nothing to reveal.
    expect(dashboard.find('[data-testid="menu-reveal"]').exists()).toBe(false);
    dashboard.unmount();
  });
});
