import { afterEach, describe, expect, it } from "vitest";
import type { VueWrapper } from "@vue/test-utils";

import { mountWithI18n } from "@/test/mount";

import Dialog from "./Dialog.vue";

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
});

const removeProps = {
  title: "Remove worktree",
  body: "This deletes /wt/claude-auth and any uncommitted changes in it. The branch claude/fix-auth is kept and can be checked out again.",
  confirmLabel: "Remove worktree",
  variant: "destructive" as const,
};

describe("Dialog", () => {
  it("is a modal dialog labelled by its title and described by its body", () => {
    wrapper = mountWithI18n(Dialog, { props: removeProps, attachTo: document.body });
    const dialog = wrapper.get("[role='dialog']");
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-labelledby")).toBe(wrapper.get("h2").attributes("id"));
    expect(dialog.attributes("aria-describedby")).toBe(wrapper.get("p").attributes("id"));
    expect(wrapper.get("h2").text()).toBe("Remove worktree");
    expect(wrapper.get("h2").classes()).toContain("text-xl");
    expect(wrapper.get("p").classes()).toContain("text-fg-secondary");
    expect(dialog.classes()).toContain("bg-raised");
    expect(dialog.classes()).toContain("rounded-lg");
    expect(dialog.classes()).toContain("shadow-overlay");
    expect(wrapper.get("[data-testid='dialog-scrim']").classes()).toContain("bg-shadow");
  });

  it("uses a red confirm button for the destructive variant and 32px buttons", () => {
    wrapper = mountWithI18n(Dialog, { props: removeProps, attachTo: document.body });
    const confirm = wrapper.get("[data-testid='dialog-confirm']");
    expect(confirm.text()).toBe("Remove worktree");
    expect(confirm.attributes("data-variant")).toBe("destructive");
    expect(confirm.classes()).toContain("h-6");
    const cancel = wrapper.get("[data-testid='dialog-cancel']");
    expect(cancel.text()).toBe("Cancel");
    expect(cancel.attributes("data-variant")).toBe("secondary");
  });

  it("uses the primary button by default and the translated labels", () => {
    wrapper = mountWithI18n(
      Dialog,
      { props: { title: "Add worktree" }, attachTo: document.body },
      { locale: "es" },
    );
    expect(wrapper.get("[data-testid='dialog-confirm']").attributes("data-variant")).toBe(
      "primary",
    );
    expect(wrapper.get("[data-testid='dialog-confirm']").text()).toBe("Confirmar");
    expect(wrapper.get("[data-testid='dialog-cancel']").text()).toBe("Cancelar");
    expect(wrapper.find("p").exists()).toBe(false);
  });

  it("moves focus inside, onto Cancel for a destructive dialog, and restores it on close", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    wrapper = mountWithI18n(Dialog, { props: removeProps, attachTo: document.body });
    expect(document.activeElement).toBe(wrapper.get("[data-testid='dialog-cancel']").element);
    wrapper.unmount();
    wrapper = undefined;
    expect(document.activeElement).toBe(opener);
  });

  it("focuses the field marked data-autofocus when there is one", () => {
    wrapper = mountWithI18n(Dialog, {
      props: { title: "Add worktree" },
      slots: { default: "<input data-autofocus name='branch' />" },
      attachTo: document.body,
    });
    expect(document.activeElement).toBe(wrapper.get("input").element);
  });

  it("emits cancel on Escape, on the scrim and on Cancel; confirm on Confirm", async () => {
    wrapper = mountWithI18n(Dialog, { props: removeProps, attachTo: document.body });
    await wrapper.get("[role='dialog']").trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    await wrapper.get("[data-testid='dialog-scrim']").trigger("pointerdown");
    expect(wrapper.emitted("cancel")).toHaveLength(2);
    await wrapper.get("[data-testid='dialog-cancel']").trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(3);
    await wrapper.get("[data-testid='dialog-confirm']").trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
  });

  it("keeps Tab inside the panel", async () => {
    wrapper = mountWithI18n(Dialog, { props: removeProps, attachTo: document.body });
    const cancel = wrapper.get("[data-testid='dialog-cancel']").element;
    const confirm = wrapper.get("[data-testid='dialog-confirm']").element;
    (confirm as HTMLElement).focus();
    await wrapper.get("[role='dialog']").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    await wrapper.get("[role='dialog']").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("can disable the confirm button", () => {
    wrapper = mountWithI18n(Dialog, {
      props: { title: "Add worktree", confirmDisabled: true },
      attachTo: document.body,
    });
    expect(wrapper.get("[data-testid='dialog-confirm']").attributes("disabled")).toBeDefined();
  });
});
