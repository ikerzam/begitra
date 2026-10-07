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

  it("hands the focus back when the toast holding it goes, and only then", async () => {
    const wrapper = mountWithI18n(ToastHost, { attachTo: document.body });
    const toasts = useToastsStore();
    let undone = 0;
    toasts.push({
      kind: "success",
      message: "Discarded 2 files",
      action: "Undo",
      onAction: () => {
        undone += 1;
      },
      sticky: true,
    });
    const other = toasts.push({ kind: "success", message: "Copied", sticky: true });
    await nextTick();
    // A toast going while the focus is elsewhere leaves the focus alone.
    toasts.dismiss(other);
    await nextTick();
    expect(wrapper.emitted("released")).toBeUndefined();

    const undo = wrapper.findAll("button").find((button) => button.text() === "Undo");
    (undo?.element as HTMLElement).focus();
    await undo?.trigger("click");
    await nextTick();
    expect(undone).toBe(1);
    expect(toasts.toasts).toEqual([]);
    expect(wrapper.emitted("released")).toHaveLength(1);
    wrapper.unmount();
  });
});
