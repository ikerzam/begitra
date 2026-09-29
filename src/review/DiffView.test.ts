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
