import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { useToastsStore } from "@/stores/toasts";
import { mountWithI18n } from "@/test/mount";

import ToastHost from "./ToastHost.vue";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  useToastsStore().clear();
});

describe("ToastHost", () => {
  it("picks a message's plural form from its count, a number or a string", async () => {
    const wrapper = mountWithI18n(ToastHost);
    const toasts = useToastsStore();
    toasts.push({ kind: "success", message: "", key: "branches.cherryPicked", params: { n: "2" } });
    toasts.push({ kind: "success", message: "", key: "branches.reverted", params: { n: 1 } });
    toasts.push({ kind: "success", message: "", key: "cleanup.deleted", params: { n: 3 } });
    // A worktree can go while its branch stays: one branch, two worktrees.
    toasts.push({
      kind: "success",
      message: "",
      key: "cleanup.deletedWithWorktrees",
      params: { n: 1, m: 2 },
    });
    await nextTick();
    expect(wrapper.findAll('[data-testid="toast-message"]').map((toast) => toast.text())).toEqual([
      "Cherry-picked 2 commits",
      "Reverted 1 commit",
      "Deleted 3 branches",
      "Deleted 1 branch and 2 worktrees",
    ]);
  });
});
