import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { detectPlatform, formatShortcut, matchesKeys, parseKeys, sameKeys } from "./platform";
import {
  ShortcutRegistry,
  defaultBindings,
  isEditableTarget,
  setShortcutRegistry,
  shortcutRegistry,
} from "./registry";
import { useListNavigation } from "./useListNavigation";
import { useShortcut } from "./useShortcut";

function key(
  k: string,
  mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {},
  target: EventTarget | null = null,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    cancelable: true,
  });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
}

afterEach(() => {
  setShortcutRegistry(undefined);
});

describe("platform", () => {
  it("detects the platform from navigator", () => {
    expect(detectPlatform({ platform: "Win32", userAgent: "Mozilla" })).toBe("windows");
    expect(detectPlatform({ platform: "MacIntel", userAgent: "Mozilla" })).toBe("macos");
    expect(detectPlatform({ platform: "Linux x86_64", userAgent: "Mozilla" })).toBe("linux");
  });

  it("renders hints per platform", () => {
    expect(formatShortcut("mod+k", "windows")).toBe("Ctrl K");
    expect(formatShortcut("mod+k", "linux")).toBe("Ctrl K");
    expect(formatShortcut("mod+k", "macos")).toBe("⌘K");
    expect(formatShortcut("shift+mod+c", "windows")).toBe("Ctrl Shift C");
    expect(formatShortcut("shift+mod+c", "macos")).toBe("⇧⌘C");
    expect(formatShortcut("j", "windows")).toBe("j");
    expect(formatShortcut("escape", "macos")).toBe("esc");
    expect(formatShortcut("enter", "windows")).toBe("↵");
    expect(formatShortcut("mod+1", "macos")).toBe("⌘1");
  });

  it("parses keys in any order", () => {
    const parsed = parseKeys("Mod+Shift+C");
    expect([...parsed.modifiers].sort()).toEqual(["mod", "shift"]);
    expect(parsed.key).toBe("c");
  });

  it("matches ctrl on windows and meta on macos", () => {
    expect(matchesKeys("mod+k", key("k", { ctrl: true }), "windows")).toBe(true);
    expect(matchesKeys("mod+k", key("k", { meta: true }), "windows")).toBe(false);
    expect(matchesKeys("mod+k", key("k", { meta: true }), "macos")).toBe(true);
    expect(matchesKeys("mod+k", key("k", { ctrl: true }), "macos")).toBe(false);
    expect(matchesKeys("mod+k", key("K", { ctrl: true, shift: true }), "windows")).toBe(false);
    expect(matchesKeys("shift+mod+c", key("C", { ctrl: true, shift: true }), "windows")).toBe(true);
    expect(matchesKeys("j", key("j"), "linux")).toBe(true);
    expect(matchesKeys("j", key("j", { ctrl: true }), "linux")).toBe(false);
  });

  it("reads ctrl as Control on macOS, where mod is ⌘, and as Ctrl elsewhere", () => {
    expect(formatShortcut("ctrl+tab", "windows")).toBe("Ctrl Tab");
    expect(formatShortcut("shift+ctrl+tab", "linux")).toBe("Ctrl Shift Tab");
    expect(formatShortcut("ctrl+tab", "macos")).toBe("⌃⇥");
    expect(formatShortcut("shift+ctrl+tab", "macos")).toBe("⌃⇧⇥");
    expect([...parseKeys("Shift+Ctrl+Tab").modifiers].sort()).toEqual(["ctrl", "shift"]);
    expect(matchesKeys("ctrl+tab", key("Tab", { ctrl: true }), "windows")).toBe(true);
    expect(matchesKeys("ctrl+tab", key("Tab", { ctrl: true }), "macos")).toBe(true);
    expect(matchesKeys("ctrl+tab", key("Tab", { meta: true }), "macos")).toBe(false);
    expect(matchesKeys("ctrl+tab", key("Tab", { ctrl: true, meta: true }), "macos")).toBe(false);
    expect(matchesKeys("ctrl+tab", key("Tab", { meta: true }), "windows")).toBe(false);
    expect(matchesKeys("ctrl+tab", key("Tab"), "windows")).toBe(false);
    expect(matchesKeys("ctrl+tab", key("Tab", { ctrl: true, shift: true }), "windows")).toBe(false);
    expect(matchesKeys("shift+ctrl+tab", key("Tab", { ctrl: true, shift: true }), "linux")).toBe(
      true,
    );
    // ⌘ chords stay ⌘ on macOS: Control does not stand in for them.
    expect(matchesKeys("mod+w", key("w", { ctrl: true }), "macos")).toBe(false);
  });

  it("tells chords apart by what they press, not by how they are written", () => {
    expect(sameKeys("ctrl+tab", "mod+tab", "windows")).toBe(true);
    expect(sameKeys("ctrl+tab", "mod+tab", "macos")).toBe(false);
    expect(sameKeys("shift+mod+c", "Mod+Shift+C", "macos")).toBe(true);
    expect(sameKeys("mod+c", "shift+mod+c", "windows")).toBe(false);
    expect(sameKeys("mod+=", "mod+-", "linux")).toBe(false);
  });

  it("takes = and + as one key for the zoom, whatever Shift or the layout says", () => {
    // US: Ctrl = and Ctrl Shift = (which types +); Spanish: the + key without Shift.
    expect(matchesKeys("mod+=", key("=", { ctrl: true }), "windows")).toBe(true);
    expect(matchesKeys("mod+=", key("+", { ctrl: true, shift: true }), "windows")).toBe(true);
    expect(matchesKeys("mod+=", key("+", { ctrl: true }), "windows")).toBe(true);
    expect(matchesKeys("mod+=", key("-", { ctrl: true }), "windows")).toBe(false);
    expect(matchesKeys("mod+-", key("-", { ctrl: true }), "windows")).toBe(true);
    expect(formatShortcut("mod+=", "windows")).toBe("Ctrl =");
  });
});

describe("ShortcutRegistry", () => {
  it("has every default binding with a hint", () => {
    const registry = new ShortcutRegistry("windows");
    const ids = registry.list().map((b) => b.id);
    expect(ids).toEqual(defaultBindings.map((b) => b.id));
    expect(registry.hint("palette")).toBe("Ctrl K");
    expect(registry.hint("compare-with")).toBe("Ctrl Shift C");
    expect(registry.hint("nope")).toBe("");
    expect(new ShortcutRegistry("macos").hint("add-worktree")).toBe("⇧⌘W");
    // Commit and push is the commit's key with Shift.
    expect(registry.hint("commit-push")).toBe("Ctrl Shift ↵");
    expect(new ShortcutRegistry("macos").hint("commit-push")).toBe("⇧⌘↵");
  });

  it("dispatches to the last attached handler and prevents default", () => {
    const registry = new ShortcutRegistry("windows");
    const first = vi.fn();
    const second = vi.fn();
    registry.register("palette", first);
    const detach = registry.register("palette", second);
    const event = key("k", { ctrl: true });
    expect(registry.dispatch(event)).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    detach();
    expect(registry.dispatch(key("k", { ctrl: true }))).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("ignores unbound keys and plain keys typed into a text field", () => {
    const registry = new ShortcutRegistry("windows");
    const next = vi.fn();
    const palette = vi.fn();
    registry.register("next-row", next);
    registry.register("palette", palette);
    expect(registry.dispatch(key("x"))).toBe(false);
    const input = document.createElement("input");
    expect(registry.dispatch(key("j", {}, input))).toBe(false);
    expect(next).not.toHaveBeenCalled();
    expect(registry.dispatch(key("k", { ctrl: true }, input))).toBe(true);
    expect(palette).toHaveBeenCalledTimes(1);
    expect(registry.dispatch(key("j", {}, document.createElement("div")))).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("takes a function key in a text field, which types nothing there", () => {
    const registry = new ShortcutRegistry("windows");
    const next = vi.fn();
    const previous = vi.fn();
    registry.register("find-next", next);
    registry.register("find-previous", previous);
    const input = document.createElement("input");
    expect(registry.dispatch(key("F3", {}, input))).toBe(true);
    expect(registry.dispatch(key("F3", { shift: true }, input))).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(registry.hint("find")).toBe("Ctrl F");
    expect(registry.hint("find-previous")).toBe("Shift F3");
  });

  it("rebinds and reports activity", () => {
    const registry = new ShortcutRegistry("linux");
    expect(registry.isActive("palette")).toBe(false);
    registry.register("palette", () => {});
    expect(registry.isActive("palette")).toBe(true);
    registry.rebind("palette", "mod+p");
    expect(registry.hint("palette")).toBe("Ctrl P");
    expect(registry.dispatch(key("p", { ctrl: true }))).toBe(true);
  });

  it("runs a handler by id for the palette, and reports when there is none", () => {
    const registry = new ShortcutRegistry("linux");
    const runs: string[] = [];
    expect(registry.run("next-symbol")).toBe(false);
    const detach = registry.register("next-symbol", () => runs.push("first"));
    registry.register("next-symbol", () => runs.push("second"));
    expect(registry.run("next-symbol")).toBe(true);
    expect(runs).toEqual(["second"]);
    detach();
    expect(registry.run("next-symbol")).toBe(true);
    expect(runs).toEqual(["second", "second"]);
  });

  it("uses a shared instance that tests can replace", () => {
    const custom = new ShortcutRegistry("macos");
    setShortcutRegistry(custom);
    expect(shortcutRegistry()).toBe(custom);
    expect(shortcutRegistry().hint("palette")).toBe("⌘K");
  });

  it("detects editable targets", () => {
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    const text = document.createElement("input");
    expect(isEditableTarget(text)).toBe(true);
    text.type = "search";
    expect(isEditableTarget(text)).toBe(true);
    // A focused checkbox (the review filters) still takes the review shortcuts.
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(isEditableTarget(checkbox)).toBe(false);
  });
});

describe("useShortcut", () => {
  it("attaches while the component is mounted and while its condition holds", async () => {
    setShortcutRegistry(new ShortcutRegistry("windows"));
    const active = ref(false);
    const handler = vi.fn();
    const Probe = defineComponent({
      setup() {
        useShortcut("mark-reviewed", handler, () => active.value);
        return () => null;
      },
    });
    const wrapper = mount(Probe);
    expect(shortcutRegistry().isActive("mark-reviewed")).toBe(false);
    active.value = true;
    await nextTick();
    expect(shortcutRegistry().run("mark-reviewed")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    active.value = false;
    await nextTick();
    expect(shortcutRegistry().isActive("mark-reviewed")).toBe(false);
    active.value = true;
    await nextTick();
    wrapper.unmount();
    expect(shortcutRegistry().isActive("mark-reviewed")).toBe(false);
  });
});

describe("useListNavigation", () => {
  it("moves with j/k and arrows, scrolls the row into view and activates with enter", () => {
    const scrolls = Array.from({ length: 6 }, () => vi.fn());
    const rows = scrolls.map((scroll) => {
      const element = document.createElement("div");
      element.scrollIntoView = scroll;
      return element;
    });
    const selected = ref(0);
    const activated: number[] = [];
    const nav = useListNavigation({
      count: ref(rows.length),
      selected,
      onActivate: (index) => activated.push(index),
      rowElement: (index) => rows[index],
    });

    for (let i = 0; i < 3; i += 1) expect(nav.onKeydown(key("j"))).toBe(true);
    expect(selected.value).toBe(3);
    expect(scrolls[3]).toHaveBeenCalledWith({ block: "nearest" });

    nav.onKeydown(key("ArrowUp"));
    expect(selected.value).toBe(2);
    nav.onKeydown(key("End"));
    expect(selected.value).toBe(5);
    nav.onKeydown(key("j"));
    expect(selected.value).toBe(5);
    nav.onKeydown(key("Home"));
    expect(selected.value).toBe(0);
    nav.onKeydown(key("k"));
    expect(selected.value).toBe(0);
    nav.onKeydown(key("Enter"));
    expect(activated).toEqual([0]);
    expect(nav.onKeydown(key("x"))).toBe(false);
    expect(nav.onKeydown(key("j", { ctrl: true }))).toBe(false);
  });

  it("focuses the row it selects, the first one on focus(), and skips handled events", () => {
    const rows = Array.from({ length: 3 }, () => {
      const element = document.createElement("div");
      element.tabIndex = -1;
      document.body.append(element);
      return element;
    });
    const selected = ref(-1);
    const nav = useListNavigation({
      count: ref(rows.length),
      selected,
      rowElement: (i) => rows[i],
    });
    nav.focus();
    expect(document.activeElement).toBe(rows[0]);
    expect(selected.value).toBe(-1);
    nav.onKeydown(key("j"));
    nav.onKeydown(key("j"));
    expect(selected.value).toBe(1);
    expect(document.activeElement).toBe(rows[1]);
    nav.focus();
    expect(document.activeElement).toBe(rows[1]);
    const handled = key("j");
    handled.preventDefault();
    expect(nav.onKeydown(handled)).toBe(false);
    expect(selected.value).toBe(1);
    // Enter or j on an item of a menu opened over the list is the menu's.
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.append(item);
    document.body.append(menu);
    expect(nav.onKeydown(key("Enter", {}, item))).toBe(false);
    expect(nav.onKeydown(key("j", {}, item))).toBe(false);
    expect(selected.value).toBe(1);
    menu.remove();
    for (const row of rows) row.remove();
  });

  it("starts from the first row when nothing is selected and can loop", () => {
    const selected = ref(-1);
    const nav = useListNavigation({ count: ref(3), selected, loop: true });
    nav.onKeydown(key("j"));
    expect(selected.value).toBe(0);
    nav.onKeydown(key("k"));
    expect(selected.value).toBe(2);
    nav.onKeydown(key("j"));
    expect(selected.value).toBe(0);
    const empty = useListNavigation({ count: ref(0), selected });
    empty.onKeydown(key("j"));
    expect(selected.value).toBe(-1);
  });
});
