import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import type { DiffLine, FileChange } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry, shortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts } from "@/shortcuts/useShortcut";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { fakeBackend, settled } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import DiffView from "./DiffView.vue";

function line(
  n: number,
  kind: DiffLine["kind"] = "context",
  spans: DiffLine["spans"] = [],
  text = `line ${n}`,
): DiffLine {
  return {
    kind,
    oldNumber: kind === "added" ? null : n,
    newNumber: kind === "removed" ? null : n,
    text,
    spans,
    noNewline: false,
  };
}

function file(lines: DiffLine[][], extra: Partial<FileChange> = {}): FileChange {
  return {
    status: "modified",
    path: "src/app.ts",
    oldPath: null,
    similarity: null,
    additions: 1,
    deletions: 0,
    hunks: lines.map((hunkLines, i) => ({
      oldStart: i * 10 + 1,
      oldLines: hunkLines.length,
      newStart: i * 10 + 1,
      newLines: hunkLines.length,
      header: `@@ -${i * 10 + 1},${hunkLines.length} +${i * 10 + 1},${hunkLines.length} @@ fn f${i}`,
      lines: hunkLines,
    })),
    isBinary: false,
    isLarge: false,
    isGenerated: false,
    isTest: false,
    isLossy: false,
    oldId: null,
    newId: null,
    ...extra,
  };
}

let uninstall: () => void = () => {};

beforeEach(() => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  uninstall = installShortcuts(window);
});

afterEach(() => {
  uninstall();
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

/** Mounts the viewer with a 200px body (ten line rows) that jsdom cannot measure itself. */
async function mountView(props: { file: FileChange | null }) {
  const wrapper = mountWithI18n(DiffView, { props, attachTo: document.body });
  const body = wrapper.find('[data-testid="diff-body"]');
  if (body.exists()) {
    Object.defineProperty(body.element, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(body.element, "clientWidth", { value: 800, configurable: true });
    await body.trigger("scroll");
  }
  return wrapper;
}

/** The menu the viewer teleports to the document's body. */
function lineMenu(): HTMLElement | null {
  return document.querySelector('[data-testid="line-menu"]');
}

describe("DiffView", () => {
  it("opens a line in the editor from its menu, a removed line at the new line where it sat", async () => {
    const calls = fakeBackend();
    await useSettingsStore().init(memoryStorage(), "windows");
    await useRepoStore().open("/r");
    await settled();
    const wrapper = await mountView({
      file: file([[line(1), line(2, "removed"), line(3, "added"), line(4)]]),
    });
    const rows = wrapper.findAll('[data-testid="diff-row"]');
    // The added line: its own new number.
    await rows[2]!.trigger("contextmenu", { clientX: 40, clientY: 60 });
    expect(lineMenu()?.textContent).toContain("Open in editor at line 3");
    expect(lineMenu()?.textContent).toContain("Copy path");
    // Nothing is selected, so there is no text to copy.
    expect(lineMenu()?.querySelector('[data-testid="line-menu-copy"]')).toBeNull();
    (lineMenu()?.querySelector('[data-testid="line-menu-editor"]') as HTMLElement).click();
    await flushPromises();
    const opened = calls.filter((call) => call.cmd === "open_external").at(-1);
    expect(opened?.args).toMatchObject({ path: "/r/src/app.ts", line: 3 });
    expect((opened?.args as { templates: string[] }).templates[0]).toBe(
      "code.cmd -g {path}:{line}",
    );
    // The removed line: the new line where it sat, the next one with a new number.
    await rows[1]!.trigger("contextmenu", { clientX: 40, clientY: 40 });
    expect(lineMenu()?.textContent).toContain("Open in editor at line 3");
    wrapper.unmount();
    // A deleted file has no line to open, only its path to copy.
    const deleted = await mountView({
      file: file([[line(1, "removed"), line(2, "removed")]], { status: "deleted" }),
    });
    await deleted.findAll('[data-testid="diff-row"]')[0]!.trigger("contextmenu");
    expect(lineMenu()?.querySelector('[data-testid="line-menu-editor"]')).toBeNull();
    expect(lineMenu()?.textContent).toContain("Copy path");
    deleted.unmount();
  });

  it("opens the working tree's file at its first change from the header", async () => {
    const calls = fakeBackend();
    await useSettingsStore().init(memoryStorage(), "windows");
    await useRepoStore().open("/r");
    await settled();
    const wrapper = await mountView({ file: file([[line(1), line(2, "added")]]) });
    await wrapper.get('[data-testid="open-in-editor"]').trigger("click");
    await flushPromises();
    const opened = calls.filter((call) => call.cmd === "open_external").at(-1);
    expect(opened?.args).toMatchObject({ path: "/r/src/app.ts", line: 2 });
    wrapper.unmount();
    const deleted = await mountView({
      file: file([[line(1, "removed")]], { status: "deleted" }),
    });
    expect(deleted.get('[data-testid="open-in-editor"]').attributes("disabled")).toBeDefined();
    deleted.unmount();
  });

  it("opens the file at the line at the top of the diff with Open file in editor", async () => {
    const calls = fakeBackend();
    await useSettingsStore().init(memoryStorage(), "windows");
    await useRepoStore().open("/r");
    await settled();
    const wrapper = await mountView({ file: file([[line(1), line(2, "added")], [line(11)]]) });
    expect(shortcutRegistry().isActive("open-file-editor")).toBe(true);
    expect(shortcutRegistry().run("open-file-editor")).toBe(true);
    await flushPromises();
    const opened = calls.filter((call) => call.cmd === "open_external").at(-1);
    // The first row is the first hunk's header: its first new line.
    expect(opened?.args).toMatchObject({ path: "/r/src/app.ts", line: 1 });
    wrapper.unmount();
    expect(shortcutRegistry().isActive("open-file-editor")).toBe(false);
  });

  it("binds Open file in editor while a file can be opened, behind a card too", async () => {
    const calls = fakeBackend();
    await useSettingsStore().init(memoryStorage(), "windows");
    await useRepoStore().open("/r");
    await settled();
    // A generated file sits behind its card: the key opens it where the header's button does.
    const generated = await mountView({
      file: file([[line(1), line(2, "added")]], { isGenerated: true }),
    });
    expect(generated.find('[data-testid="diff-guard"]').exists()).toBe(true);
    expect(shortcutRegistry().run("open-file-editor")).toBe(true);
    await flushPromises();
    const opened = calls.filter((call) => call.cmd === "open_external").at(-1);
    expect(opened?.args).toMatchObject({ path: "/r/src/app.ts", line: 2 });
    generated.unmount();
    // A deleted file has nothing to open: the key and its palette row stay inactive.
    const deleted = await mountView({
      file: file([[line(1, "removed")]], { status: "deleted" }),
    });
    expect(shortcutRegistry().isActive("open-file-editor")).toBe(false);
    deleted.unmount();
  });

  it("names the line its header button opens at, and keeps the file name whole", async () => {
    fakeBackend();
    await useSettingsStore().init(memoryStorage(), "windows");
    await useRepoStore().open("/r");
    await settled();
    const wrapper = await mountView({
      file: file([[line(1), line(2, "added")]], { path: "packages/map/src/tile-cache.ts" }),
    });
    const button = wrapper.get('[data-testid="open-in-editor"]');
    expect(button.attributes("aria-label")).toBe("Open in editor at line 2");
    const path = wrapper.get('[data-testid="diff-path"]');
    expect(path.text()).toBe("packages/map/src/tile-cache.ts");
    expect(path.attributes("data-tooltip")).toBe("packages/map/src/tile-cache.ts");
    // The folder truncates; the name does not shrink.
    const [folder, name] = path.findAll("span");
    expect(folder?.classes()).toContain("truncate");
    expect(name?.text()).toBe("tile-cache.ts");
    expect(name?.classes()).toContain("shrink-0");
    wrapper.unmount();
  });

  it("opens the keyboard's menu under the row it names and gives the focus back on close", async () => {
    fakeBackend();
    await useSettingsStore().init(memoryStorage(), "windows");
    await useRepoStore().open("/r");
    await settled();
    const wrapper = await mountView({
      file: file([[line(1), line(2, "added")]]),
    });
    const body = wrapper.get('[data-testid="diff-body"]');
    (body.element as HTMLElement).focus();
    await body.trigger("keydown", { key: "ContextMenu" });
    await nextTick();
    const menu = wrapper.findComponent({ name: "LineMenu" });
    // The top row is the hunk's header (28px): the menu opens under it, at the code.
    expect(menu.props("y")).toBe(28);
    expect(menu.props("x")).toBe(116);
    expect(menu.props("line")).toBe(1);
    // Escape closes it and the rows take the focus back, so the keys keep working.
    lineMenu()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(lineMenu()).toBeNull();
    expect(document.activeElement).toBe(body.element);
    wrapper.unmount();
  });

  it("closes the line menu when another file opens", async () => {
    fakeBackend();
    await useSettingsStore().init(memoryStorage(), "windows");
    await useRepoStore().open("/r");
    await settled();
    const wrapper = await mountView({ file: file([[line(1), line(2, "added")]]) });
    await wrapper.findAll('[data-testid="diff-row"]')[1]!.trigger("contextmenu");
    expect(lineMenu()).not.toBeNull();
    await wrapper.setProps({ file: file([[line(1), line(2, "added")]], { path: "src/b.ts" }) });
    await nextTick();
    expect(lineMenu()).toBeNull();
    wrapper.unmount();
  });

  it("paints its body of rows in the code theme, or leaves it to the window's", async () => {
    fakeBackend();
    const settings = useSettingsStore();
    await settings.init(memoryStorage(), "windows");
    const wrapper = await mountView({ file: file([[line(1), line(2, "added")]]) });
    const body = wrapper.get('[data-testid="diff-body"]');
    // "Same as the app": no attribute, so the rows inherit the document root's theme.
    expect(body.attributes("data-theme")).toBeUndefined();
    // The body paints its own background, so a code theme fills it to the edges.
    expect(body.classes()).toEqual(expect.arrayContaining(["bg-app", "text-fg"]));
    await settings.update("codeTheme", "one-dark");
    await nextTick();
    expect(body.attributes("data-theme")).toBe("one-dark");
    await settings.update("codeTheme", "app");
    await nextTick();
    expect(body.attributes("data-theme")).toBeUndefined();
    wrapper.unmount();
    // The card of a file behind "Show anyway" takes it too.
    await settings.update("codeTheme", "ayu-light");
    const generated = await mountView({ file: file([[line(1)]], { isGenerated: true }) });
    expect(generated.get('[data-testid="diff-guard"]').attributes("data-theme")).toBe("ayu-light");
    generated.unmount();
  });

  describe("unchanged lines", () => {
    /** A working tree file of `count` lines "line N", its diff's hunks computed from it. */
    async function mountWorktreeFile(
      hunkLines: DiffLine[][],
      count: number,
      starts: number[],
      text?: string,
      whole = false,
    ) {
      fakeBackend({
        blobTexts: {
          "src/app.ts": text ?? Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join(""),
        },
      });
      await useSettingsStore().init(memoryStorage(), "windows");
      if (whole) await useSettingsStore().update("diffWholeFile", true);
      await useRepoStore().open("/r");
      useReviewStore().setTarget({ kind: "worktree" });
      await settled();
      const changed = file(hunkLines);
      changed.hunks.forEach((hunk, i) => {
        hunk.newStart = starts[i] ?? hunk.newStart;
        hunk.oldStart = starts[i] ?? hunk.oldStart;
      });
      const wrapper = await mountView({ file: changed });
      for (let i = 0; i < 4; i += 1) await settled();
      await nextTick();
      return wrapper;
    }
    /** A click as a mouse gives it (detail 1); a press of Enter or Space gives detail 0. */
    const mouseClick = async (wrapper: ReturnType<typeof mountWithI18n>, testid: string) => {
      wrapper
        .get(`[data-testid="${testid}"]`)
        .element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      await nextTick();
    };
    const gaps = (wrapper: ReturnType<typeof mountWithI18n>) =>
      wrapper.findAll('[data-testid="gap-row"]').map((row) => row.text());
    const newNumbers = (wrapper: ReturnType<typeof mountWithI18n>) =>
      wrapper
        .findAll('[data-testid="diff-row"]')
        .map((row) => Number(row.find('[data-testid="diff-row-new"]').text()));

    it("folds the lines between and after the hunks and shows a gap's on a click", async () => {
      const wrapper = await mountWorktreeFile(
        [
          [line(1), line(2, "added"), line(3)],
          [line(11), line(12)],
        ],
        30,
        [1, 11],
      );
      expect(gaps(wrapper)).toEqual(["7 unchanged lines", "18 unchanged lines"]);
      // Short runs show whole on one click: no 20-line controls.
      expect(wrapper.find('[data-testid="gap-next"]').exists()).toBe(false);
      await wrapper.get('[data-testid="gap-all"]').trigger("click");
      await nextTick();
      expect(gaps(wrapper)).toEqual(["18 unchanged lines"]);
      expect(newNumbers(wrapper).slice(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      wrapper.unmount();
    });

    it("shows twenty lines at a time from either side of a long run", async () => {
      const wrapper = await mountWorktreeFile(
        [
          [line(1), line(2, "added"), line(3)],
          [line(101), line(102)],
        ],
        102,
        [1, 101],
      );
      expect(gaps(wrapper)).toEqual(["97 unchanged lines"]);
      // A mouse click (detail 1) reveals in place, without moving the view.
      await mouseClick(wrapper, "gap-next");
      await nextTick();
      // The twenty lines take the gap's place under the first hunk; the gap moved below the
      // ten rows the test's viewport holds.
      expect(newNumbers(wrapper).slice(3, 6)).toEqual([4, 5, 6]);
      const body = wrapper.get('[data-testid="diff-body"]');
      body.element.scrollTop = 28 + 23 * 20 - 100;
      await body.trigger("scroll");
      expect(gaps(wrapper)).toEqual(["77 unchanged lines"]);
      await mouseClick(wrapper, "gap-previous");
      await nextTick();
      expect(gaps(wrapper)).toEqual(["57 unchanged lines"]);
      wrapper.unmount();
    });

    it("keeps the keyboard on the gap that continues, and on the rows once it is gone", async () => {
      const wrapper = await mountWorktreeFile(
        [
          [line(1), line(2, "added"), line(3)],
          [line(101), line(102)],
        ],
        102,
        [1, 101],
      );
      const press = async (testid: string) => {
        const control = document.activeElement?.closest('[data-testid="gap-row"]')
          ? (document.activeElement as HTMLElement)
          : (wrapper.get(`[data-testid="${testid}"]`).element as HTMLElement);
        control.focus();
        control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
        await flushPromises();
        await nextTick();
      };
      const focusedGap = () =>
        document.activeElement?.closest('[data-testid="gap-row"]')?.textContent?.trim();
      // Enter on "the next 20" shows them and lands on the same control of the rest.
      await press("gap-next");
      expect(focusedGap()).toBe("77 unchanged lines");
      expect((document.activeElement as HTMLElement).dataset["testid"]).toBe("gap-next");
      // "The previous 20" keeps the row, which keeps the focus.
      (wrapper.get('[data-testid="gap-previous"]').element as HTMLElement).focus();
      await press("gap-previous");
      expect(focusedGap()).toBe("57 unchanged lines");
      expect((document.activeElement as HTMLElement).dataset["testid"]).toBe("gap-previous");
      // "Show all" takes the row away: the rows keep the focus.
      (wrapper.get('[data-testid="gap-all"]').element as HTMLElement).focus();
      await press("gap-all");
      expect(document.activeElement).toBe(wrapper.get('[data-testid="diff-body"]').element);
      wrapper.unmount();
    });

    it("keeps the line on top in place when Whole file turns on and off", async () => {
      const wrapper = await mountWorktreeFile(
        [
          [line(1), line(2, "added"), line(3)],
          [line(101), line(102)],
        ],
        102,
        [1, 101],
      );
      const body = wrapper.get('[data-testid="diff-body"]');
      // The second hunk's header at the top: its first new line is 101.
      body.element.scrollTop = 28 + 3 * 20 + 28;
      await body.trigger("scroll");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
      await flushPromises();
      await nextTick();
      // Lines 4 to 100 now sit above it.
      expect(body.element.scrollTop).toBe(28 + 3 * 20 + 97 * 20);
      await body.trigger("scroll");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
      await flushPromises();
      await nextTick();
      expect(body.element.scrollTop).toBe(28 + 3 * 20 + 28);
      wrapper.unmount();
    });

    it("opens a file with Whole file on at its first change once its lines are in", async () => {
      const wrapper = await mountWorktreeFile(
        [[line(101), line(102, "added")]],
        102,
        [101],
        undefined,
        true,
      );
      const body = wrapper.get('[data-testid="diff-body"]');
      // Lines 1 to 100 above the hunk's header, which is the first row in view.
      expect(body.element.scrollTop).toBe(100 * 20);
      wrapper.unmount();
    });

    it("shows the whole file with e, the header's toggle pressed, and keeps it", async () => {
      const wrapper = await mountWorktreeFile(
        [
          [line(1), line(2, "added"), line(3)],
          [line(11), line(12)],
        ],
        30,
        [1, 11],
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
      await flushPromises();
      expect(useSettingsStore().values.diffWholeFile).toBe(true);
      expect(gaps(wrapper)).toEqual([]);
      expect(wrapper.get('[data-testid="toggle-whole-file"]').attributes("aria-pressed")).toBe(
        "true",
      );
      await wrapper.get('[data-testid="toggle-whole-file"]').trigger("click");
      await flushPromises();
      expect(useSettingsStore().values.diffWholeFile).toBe(false);
      expect(gaps(wrapper)).toHaveLength(2);
      wrapper.unmount();
    });

    it("keeps the lines folded and their controls disabled when the file moved", async () => {
      const moved = [
        "// added on disk since",
        ...Array.from({ length: 30 }, (_, i) => `line ${i + 1}`),
      ];
      const wrapper = await mountWorktreeFile(
        [
          [line(1), line(2, "added"), line(3)],
          [line(11), line(12)],
        ],
        30,
        [1, 11],
        `${moved.join("\n")}\n`,
      );
      // The run after the last hunk needs the file's length: it is not shown.
      expect(gaps(wrapper)).toEqual(["7 unchanged lines"]);
      const all = wrapper.get('[data-testid="gap-all"]');
      expect(all.attributes("disabled")).toBeDefined();
      // The tooltip says why, on the button's own box since a disabled button takes no pointer.
      expect(all.element.parentElement?.dataset["tooltip"]).toBe(
        "The file changed on disk; its lines show after the reload.",
      );
      wrapper.unmount();
    });
  });

  it("renders a header row per hunk and the lines with their emphasis spans", async () => {
    fakeBackend();
    const wrapper = await mountView({
      file: file([[line(1), line(2, "added", [{ start: 5, end: 6 }])], [line(11)]]),
    });
    expect(wrapper.findAll('[data-testid="hunk-row"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="hunk-row-symbol"]').text()).toBe("fn f0");
    const rows = wrapper.findAll('[data-testid="diff-row"]');
    expect(rows.map((row) => row.attributes("data-kind"))).toEqual(["context", "add", "context"]);
    expect(rows[1]?.find(".bg-add-emphasis").text()).toBe("2");
    wrapper.unmount();
  });

  it("virtualises a long diff: only the viewport and the overscan are in the DOM", async () => {
    fakeBackend();
    const lines = Array.from({ length: 10_000 }, (_, i) => line(i + 1));
    const wrapper = await mountView({ file: file([lines]) });
    const rows = wrapper.findAll('[data-testid="diff-row"]');
    expect(rows.length).toBeLessThan(120);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const spacer = wrapper.get('[data-testid="diff-rows"]');
    expect(spacer.attributes("style")).toContain(`height: ${28 + 10_000 * 20}px`);
    // Scrolling far down renders rows from there.
    const body = wrapper.get('[data-testid="diff-body"]');
    body.element.scrollTop = 5_000 * 20;
    await body.trigger("scroll");
    const first = wrapper.findAll('[data-testid="diff-row"]')[0];
    expect(Number(first?.find('[data-testid="diff-row-new"]').text())).toBeGreaterThan(4_900);
    wrapper.unmount();
  });

  it("pairs removed and added lines side by side and wraps long lines", async () => {
    fakeBackend();
    const review = useReviewStore();
    await review.setLayout("side-by-side");
    const long = "x".repeat(300);
    const wrapper = await mountView({
      file: file([[line(1), line(2, "removed"), line(2, "added", [], long), line(3, "added")]]),
    });
    const pairs = wrapper.findAll('[data-testid="side-by-side-row"]');
    expect(pairs).toHaveLength(3);
    expect(pairs[1]?.get('[data-testid="side-left"]').text()).toContain("line 2");
    expect(pairs[1]?.get('[data-testid="side-right"]').text()).toContain("xxx");
    expect(pairs[2]?.get('[data-testid="side-left"]').classes()).toContain("bg-hover");
    expect(pairs[2]?.get('[data-testid="side-right"]').text()).toContain("line 3");
    await review.setWrap(true);
    await nextTick();
    const wrapped = wrapper.findAll("[data-row]");
    // The long pair takes more than one line row; the others keep 20px.
    const heights = wrapped.map((row) => row.attributes("style"));
    expect(heights[1]).toContain("min-height: 20px");
    expect(heights[2]).not.toContain("min-height: 20px");
    wrapper.unmount();
  });

  it("collapses generated and large files behind Show anyway", async () => {
    fakeBackend();
    const wrapper = await mountView({
      file: file([[line(1)]], { isGenerated: true, additions: 12_400 }),
    });
    const guard = wrapper.get('[data-testid="diff-guard"]');
    expect(guard.text()).toContain("Generated file, 12,400 lines added");
    expect(wrapper.find('[data-testid="diff-row"]').exists()).toBe(false);
    await guard.findAll("button")[0]!.trigger("click");
    await nextTick();
    expect(wrapper.find('[data-testid="diff-guard"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="diff-row"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it("names the status of a binary file in the viewer's language and shows images", async () => {
    fakeBackend();
    const binary = file([], { status: "added", isBinary: true, path: "logo.bin" });
    const english = await mountView({ file: binary });
    expect(english.get('[data-testid="diff-guard-title"]').text()).toBe("Binary file, added");
    english.unmount();
    const spanish = mountWithI18n(DiffView, { props: { file: binary } }, { locale: "es" });
    expect(spanish.text()).toContain("Fichero binario, añadido");
    spanish.unmount();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const image = await mountView({
      file: file([], { status: "added", isBinary: true, path: "docs/tiles-worker.png" }),
    });
    await flushPromises();
    expect(image.get('[data-testid="image-before"]').text()).toBe("Not in the parent commit");
    expect(image.get('[data-testid="image-after"] img').attributes("src")).toBe(
      "data:image/png;base64,iVBORwA=",
    );
    expect(image.get('[data-testid="image-after-line"]').text()).toContain("PNG");
    image.unmount();
  });

  it("shows the empty state without a file and the banner with Show new file after a failure", async () => {
    fakeBackend({ failDiff: true });
    const empty = await mountView({ file: null });
    expect(empty.text()).toContain("Select a file to see its diff");
    empty.unmount();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    const wrapper = await mountView({ file: file([[line(1)]], { path: "src/app.ts" }) });
    const banner = wrapper.get('[data-testid="diff-failed"]');
    expect(banner.text()).toContain("Couldn't compute the diff for src/app.ts.");
    expect(banner.text()).toContain("fatal: unable to read");
    await banner.get("button").trigger("click");
    await flushPromises();
    await nextTick();
    const rows = wrapper.findAll('[data-testid="diff-row"]');
    expect(rows.map((row) => row.attributes("data-kind"))).toEqual(["add", "add", "add", "add"]);
    expect(rows[0]?.text()).toContain("fn main() {");
    // The lines read whole take the new side's colours, as any file's do.
    await flushPromises();
    await nextTick();
    const first = wrapper.findAll('[data-testid="diff-row"]')[0];
    expect(first?.find(".text-syntax-keyword").text()).toBe("fn");
    wrapper.unmount();
  });

  it("jumps between changed symbols with ] and [ and names them", async () => {
    fakeBackend();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const review = useReviewStore();
    const lines = Array.from({ length: 60 }, (_, i) =>
      line(i + 1, i === 2 || i === 40 ? "added" : "context"),
    );
    const wrapper = await mountView({ file: file([lines], { path: "src/00.rs" }) });
    await flushPromises();
    // The fake backend lists one function over lines 1 to 4: the added line 3 is inside it.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "]" }));
    await nextTick();
    expect(review.currentSymbol).toBe("main");
    const body = wrapper.get('[data-testid="diff-body"]');
    await body.trigger("scroll");
    expect(review.currentSymbol).toBeNull();
    wrapper.unmount();
  });
});
