import { Copy, Trash2 } from "@lucide/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import type { VueWrapper } from "@vue/test-utils";

import { mountWithI18n } from "@/test/mount";

import ContextMenu from "./ContextMenu.vue";
import ContextMenuItem from "./ContextMenuItem.vue";
import ContextMenuSeparator from "./ContextMenuSeparator.vue";

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountMenu(onCopy = vi.fn(), onRemove = vi.fn()) {
  wrapper = mountWithI18n(ContextMenu, {
    attachTo: document.body,
    slots: {
      default: () => [
        h(ContextMenuItem, { label: "Copy hash", icon: Copy, keys: "⌘C", onSelect: onCopy }),
        h(ContextMenuItem, { label: "Diff from here", context: "a1b2c3d" }),
        h(ContextMenuSeparator),
        h(ContextMenuItem, { label: "Open in editor", disabled: true }),
        h(ContextMenuItem, {
          label: "Remove worktree…",
          icon: Trash2,
          destructive: true,
          onSelect: onRemove,
        }),
      ],
    },
  });
  return wrapper;
}

function labels(menu: VueWrapper) {
  return menu.findAll("[role='menuitem']").map((item) => item.text());
}

function focusedLabel() {
  return document.activeElement?.textContent?.trim();
}

describe("ContextMenu", () => {
  it("is a raised menu that focuses its first item on open", () => {
    const menu = mountMenu();
    expect(menu.attributes("role")).toBe("menu");
    expect(menu.attributes("aria-label")).toBe("Context menu");
    expect(menu.classes()).toContain("bg-raised");
    expect(menu.classes()).toContain("rounded-lg");
    expect(menu.classes()).toContain("shadow-overlay");
    expect(menu.classes()).not.toContain("fixed");
    expect(labels(menu)).toEqual([
      "Copy hash⌘C",
      "Diff from herea1b2c3d",
      "Open in editor",
      "Remove worktree…",
    ]);
    expect(menu.get("[role='separator']").classes()).toContain("bg-line");
    expect(menu.get("[role='separator']").classes()).toContain("-mx-1");
    expect(focusedLabel()).toContain("Copy hash");
  });

  it("renders icon, label, muted context, kbd, disabled and destructive items", () => {
    const menu = mountMenu();
    const [copy, diff, editor, remove] = menu.findAll("[role='menuitem']");
    expect(copy?.get("svg").classes()).toContain("text-fg-secondary");
    expect(copy?.get("kbd").text()).toBe("⌘C");
    expect(copy?.classes()).toContain("h-control");
    expect(copy?.classes()).toContain("focus:bg-selected");
    expect(diff?.get("span + span").classes()).toContain("text-fg-muted");
    expect(editor?.attributes("aria-disabled")).toBe("true");
    expect(editor?.classes()).toContain("text-fg-disabled");
    expect(remove?.classes()).toContain("text-danger");
    expect(remove?.get("svg").classes()).toContain("text-danger");
    expect(remove?.attributes("data-destructive")).toBe("true");
  });

  it("lands on a disabled item that says why, and describes it by its reason", async () => {
    wrapper = mountWithI18n(ContextMenu, {
      attachTo: document.body,
      slots: {
        default: () => [
          h(ContextMenuItem, { label: "Set upstream…" }),
          h(ContextMenuItem, { label: "Checkout", disabled: true }),
          h(ContextMenuItem, {
            label: "Fast-forward to origin/develop",
            disabled: true,
            context: "2 commits of its own",
          }),
          h(ContextMenuItem, { label: "Push" }),
        ],
      },
    });
    const menu = wrapper;
    // The first item has the focus as the menu opens.
    expect(focusedLabel()).toBe("Set upstream…");
    // The plain disabled item is skipped, the one with a reason is not.
    await menu.trigger("keydown", { key: "ArrowDown" });
    const explained = document.activeElement as HTMLElement;
    expect(explained.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(explained.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("2 commits of its own");
    expect(reason?.getAttribute("aria-hidden")).toBe("true");
    await menu.trigger("keydown", { key: "ArrowDown" });
    expect(focusedLabel()).toBe("Push");
  });

  it("moves with the arrow keys, skips disabled items and wraps around", async () => {
    const menu = mountMenu();
    await menu.trigger("keydown", { key: "ArrowDown" });
    expect(focusedLabel()).toContain("Diff from here");
    await menu.trigger("keydown", { key: "ArrowDown" });
    expect(focusedLabel()).toContain("Remove worktree");
    await menu.trigger("keydown", { key: "ArrowDown" });
    expect(focusedLabel()).toContain("Copy hash");
    await menu.trigger("keydown", { key: "ArrowUp" });
    expect(focusedLabel()).toContain("Remove worktree");
    await menu.trigger("keydown", { key: "Home" });
    expect(focusedLabel()).toContain("Copy hash");
    await menu.trigger("keydown", { key: "End" });
    expect(focusedLabel()).toContain("Remove worktree");
  });

  it("closes on Escape and on Tab", async () => {
    const menu = mountMenu();
    await menu.trigger("keydown", { key: "Escape" });
    expect(menu.emitted("close")).toHaveLength(1);
    await menu.trigger("keydown", { key: "Tab" });
    expect(menu.emitted("close")).toHaveLength(2);
  });

  it("selects an item with a click and then closes; disabled items do nothing", async () => {
    const onCopy = vi.fn();
    const menu = mountMenu(onCopy);
    const [copy, , editor] = menu.findAll("[role='menuitem']");
    await copy?.trigger("click");
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(menu.emitted("close")).toHaveLength(1);
    await editor?.trigger("click");
    expect(menu.emitted("close")).toHaveLength(1);
  });

  it("closes when the pointer goes down outside", () => {
    const menu = mountMenu();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.emitted("close")).toHaveLength(1);
    menu
      .get("[role='menuitem']")
      .element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.emitted("close")).toHaveLength(1);
  });

  it("ignores a pointer going down on its anchor", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    wrapper = mountWithI18n(ContextMenu, { props: { anchor }, attachTo: document.body });
    anchor.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(wrapper.emitted("close")).toBeUndefined();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(wrapper.emitted("close")).toHaveLength(1);
    anchor.remove();
  });

  it("fixes itself at the given viewport position", () => {
    wrapper = mountWithI18n(ContextMenu, { props: { x: 120, y: 240, label: "Commit actions" } });
    expect(wrapper.attributes("aria-label")).toBe("Commit actions");
    expect(wrapper.classes()).toContain("fixed");
    expect(wrapper.attributes("style")).toContain("left: 120px");
    expect(wrapper.attributes("style")).toContain("top: 240px");
  });

  it("opens on the other side of its point where it would leave the window", async () => {
    // jsdom's window is 1024 x 768 and lays nothing out: the menu measures 200 x 160 here.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 160 }),
    );
    wrapper = mountWithI18n(ContextMenu, { props: { x: 1000, y: 700 } });
    await wrapper.vm.$nextTick();
    expect(wrapper.attributes("style")).toContain("left: 800px");
    expect(wrapper.attributes("style")).toContain("top: 540px");
    await wrapper.setProps({ x: 100, y: 100 });
    await wrapper.vm.$nextTick();
    expect(wrapper.attributes("style")).toContain("left: 100px");
    expect(wrapper.attributes("style")).toContain("top: 100px");
  });

  it("translates its default name", () => {
    wrapper = mountWithI18n(ContextMenu, {}, { locale: "es" });
    expect(wrapper.attributes("aria-label")).toBe("Menú contextual");
  });

  it("is placed again when the window is resized", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 160 }),
    );
    wrapper = mountWithI18n(ContextMenu, { props: { x: 700, y: 500 } });
    await wrapper.vm.$nextTick();
    expect(wrapper.attributes("style")).toContain("left: 700px");
    vi.stubGlobal("innerWidth", 800);
    window.dispatchEvent(new Event("resize"));
    await wrapper.vm.$nextTick();
    expect(wrapper.attributes("style")).toContain("left: 500px");
  });
});
