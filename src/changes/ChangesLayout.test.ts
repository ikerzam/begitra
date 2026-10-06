import { clearMocks } from "@tauri-apps/api/mocks";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type { PatchSelection, Ref as GitRef, Remote } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts } from "@/shortcuts/useShortcut";
import { useChangesStore } from "@/stores/changes";
import { useFindStore } from "@/stores/find";
import { useGraphStore } from "@/stores/graph";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useToastsStore } from "@/stores/toasts";
import {
  fakeBackend,
  fakeCommit,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import ChangesLayout from "./ChangesLayout.vue";

const unstagedFiles = () => [
  changedFile("src/a.ts"),
  changedFile("src/b.ts"),
  changedFile("src/new.md", { status: "added", additions: 3, deletions: 0 }),
];
const stagedFiles = () => [changedFile("src/c.ts")];

let uninstall: () => void = () => {};

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
  setShortcutRegistry(new ShortcutRegistry("windows"));
  uninstall = installShortcuts(window);
});

afterEach(() => {
  uninstall();
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

/** Opens the repository and mounts the screen with a 200px diff body jsdom cannot measure. */
async function mountScreen(options: FakeBackendOptions = {}) {
  const calls = fakeBackend({
    changes: { unstaged: unstagedFiles(), staged: stagedFiles() },
    ...options,
  });
  await useRepoStore().open("/r");
  await settled();
  const wrapper = mountWithI18n(ChangesLayout, { attachTo: document.body });
  await settled();
  await measure(wrapper);
  return { wrapper, calls };
}

async function measure(wrapper: VueWrapper): Promise<void> {
  const body = wrapper.find('[data-testid="diff-body"]');
  if (!body.exists()) return;
  Object.defineProperty(body.element, "clientHeight", { value: 200, configurable: true });
  Object.defineProperty(body.element, "clientWidth", { value: 800, configurable: true });
  await body.trigger("scroll");
  await nextTick();
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

function press(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init, bubbles: true }));
}

describe("ChangesLayout", () => {
  it("lists both lists with their letters and opens the selected file with hunk actions", async () => {
    const { wrapper } = await mountScreen();
    const headers = wrapper.findAll('[data-testid="panel-header"]');
    expect(headers.map((h) => h.get('[data-testid="panel-header-title"]').text())).toEqual([
      "Unstaged",
      "Staged",
    ]);
    expect(headers.map((h) => h.get('[data-testid="panel-header-count"]').text())).toEqual([
      "3",
      "1",
    ]);
    const rows = wrapper.findAll('[data-testid="tree-row"]');
    expect(rows.map((row) => row.attributes("data-path"))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/new.md",
      "src/c.ts",
    ]);
    // Each row names its file, then its folder, muted: two files of a folder read apart.
    expect(rows[0]?.get('[data-testid="tree-row-name"]').text()).toBe("a.ts");
    expect(rows[0]?.get('[data-testid="tree-row-folder"]').text()).toBe("src");
    expect(rows[0]?.get('[data-testid="tree-row-folder"]').classes()).toContain("text-fg-muted");
    expect(rows[2]?.find('[data-status="untracked"]').text()).toBe("?");
    expect(rows[3]?.find('[data-status="modified"]').exists()).toBe(true);
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[data-testid="changes-path"]').text()).toBe("src/a.ts");
    const hunk = wrapper.get('[data-testid="hunk-row"]');
    expect(hunk.get('[data-testid="hunk-stage"]').text()).toBe("Stage hunk");
    expect(hunk.get('[data-testid="hunk-discard"]').text()).toBe("Discard hunk…");
    expect(wrapper.get('[data-testid="file-action"]').text()).toBe("Discard file…");
    wrapper.unmount();
  });

  it("picks lines with a click and stages them, the rest staying unstaged", async () => {
    const { wrapper, calls } = await mountScreen();
    const rows = wrapper.findAll('[data-testid="diff-row"]');
    // The hunk's lines, then the file's last line, which a one-line fold would only hide.
    expect(rows.map((row) => row.attributes("data-kind"))).toEqual([
      "context",
      "del",
      "add",
      "add",
      "context",
    ]);
    await rows[1]!.trigger("click");
    await rows[3]!.trigger("click", { shiftKey: true });
    await nextTick();
    expect(wrapper.findAll('[data-testid="diff-row"][data-selected="true"]')).toHaveLength(3);
    // A context line cannot be picked; a picked line toggles off again.
    await rows[0]!.trigger("click");
    await rows[3]!.trigger("click");
    await nextTick();
    expect(wrapper.findAll('[data-testid="diff-row"][data-selected="true"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="changes-selected-count"]').text()).toBe("2 lines selected");
    const stage = wrapper.get('[data-testid="hunk-stage"]');
    expect(stage.text()).toBe("Stage lines");
    await stage.trigger("click");
    await settled();
    const applied = of(calls, "apply_selection");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.args["target"]).toBe("stage");
    const selection = applied[0]?.args["selection"] as PatchSelection;
    expect(selection.path).toBe("src/a.ts");
    expect(selection.hunks[0]?.lines.map((line) => line.selected)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // The file is in both lists now and the picked lines are gone with the reload.
    const paths = wrapper
      .findAll('[data-testid="tree-row"]')
      .map((row) => row.attributes("data-path"));
    expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/new.md", "src/a.ts", "src/c.ts"]);
    expect(wrapper.findAll('[data-selected="true"]')).toHaveLength(0);
    wrapper.unmount();
  });

  it("keeps the cursor on its line when the whole file shows, and never lands on an unchanged one", async () => {
    const { wrapper } = await mountScreen();
    for (let i = 0; i < 4; i += 1) await settled();
    // The file's last line is outside the hunk; one line shows as it is rather than folded.
    expect(wrapper.findAll('[data-testid="gap-row"]')).toHaveLength(0);
    const body = wrapper.get('[data-testid="diff-body"]');
    await body.trigger("keydown", { key: "ArrowDown" });
    await body.trigger("keydown", { key: "ArrowDown" });
    await useReviewStore().setWholeFile(true);
    await nextTick();
    let rows = wrapper.findAll('[data-testid="diff-row"]');
    expect(rows.map((row) => row.attributes("data-kind"))).toEqual([
      "context",
      "del",
      "add",
      "add",
      "context",
    ]);
    expect(rows[2]?.classes()).toContain("diff-row-cursor");
    // The cursor stops at the last changed line; the shown line cannot be picked.
    await body.trigger("keydown", { key: "ArrowDown" });
    await body.trigger("keydown", { key: "ArrowDown" });
    await nextTick();
    rows = wrapper.findAll('[data-testid="diff-row"]');
    expect(rows[3]?.classes()).toContain("diff-row-cursor");
    await rows[4]!.trigger("click");
    await nextTick();
    expect(wrapper.findAll('[data-selected="true"]')).toHaveLength(0);
    wrapper.unmount();
  });

  it("moves a cursor over the changed lines with the arrows and picks with Space, on both layouts", async () => {
    const { wrapper } = await mountScreen();
    const body = wrapper.get('[data-testid="diff-body"]');
    await body.trigger("keydown", { key: "ArrowDown" });
    await body.trigger("keydown", { key: "ArrowDown" });
    await nextTick();
    const rows = wrapper.findAll('[data-testid="diff-row"]');
    expect(rows[2]?.classes()).toContain("diff-row-cursor");
    await body.trigger("keydown", { key: " " });
    await nextTick();
    expect(rows[2]?.attributes("data-selected")).toBe("true");
    expect(rows[1]?.attributes("data-selected")).toBeUndefined();
    // Escape drops the cursor, not the picked lines.
    await body.trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(wrapper.findAll(".diff-row-cursor")).toHaveLength(0);
    expect(wrapper.findAll('[data-selected="true"]')).toHaveLength(1);
    // Side by side keeps the pick (the added line, now on the right of the first pair); a
    // click on the left cell picks the removed line beside it.
    await useReviewStore().setLayout("side-by-side");
    await nextTick();
    await measure(wrapper);
    const pairs = wrapper.findAll('[data-testid="side-by-side-row"]');
    expect(pairs[1]?.get('[data-testid="side-right"]').attributes("data-selected")).toBe("true");
    expect(pairs[1]?.get('[data-testid="side-left"]').attributes("data-selected")).toBeUndefined();
    await pairs[1]!.get('[data-testid="side-left"]').trigger("click");
    await nextTick();
    expect(pairs[1]?.get('[data-testid="side-left"]').attributes("data-selected")).toBe("true");
    expect(wrapper.get('[data-testid="changes-selected-count"]').text()).toBe("2 lines selected");
    wrapper.unmount();
  });

  it("stages the selected file with s, unstages with u from the row menu, moves with j", async () => {
    const { wrapper, calls } = await mountScreen();
    (wrapper.get('[data-list="unstaged"][data-path="src/a.ts"]').element as HTMLElement).focus();
    press("s");
    await settled();
    await nextTick();
    expect(of(calls, "stage_paths")[0]?.args["paths"]).toEqual(["src/a.ts"]);
    // The row that took its place is selected and keeps the focus: src/b.ts.
    expect(wrapper.get('[data-testid="changes-path"]').text()).toBe("src/b.ts");
    expect(document.activeElement?.getAttribute("data-path")).toBe("src/b.ts");
    press("j");
    await nextTick();
    expect(wrapper.get('[data-testid="changes-path"]').text()).toBe("src/new.md");
    // Enter on a row opens its menu; the staged rows offer Unstage.
    const staged = wrapper.findAll('[data-list="staged"]');
    await staged[0]!.trigger("contextmenu");
    await nextTick();
    expect(wrapper.find('[data-testid="menu-stage"]').exists()).toBe(false);
    // Every row's menu also copies the path and opens the file in the editor.
    expect(wrapper.find('[data-testid="menu-copy-path"]').exists()).toBe(true);
    await wrapper.get('[data-testid="menu-editor"]').trigger("click");
    await settled();
    expect(of(calls, "open_external")[0]?.args["path"]).toBe("/r/src/a.ts");
    await staged[0]!.trigger("contextmenu");
    await nextTick();
    await wrapper.get('[data-testid="menu-unstage"]').trigger("click");
    await settled();
    expect(of(calls, "unstage_paths")[0]?.args["paths"]).toEqual(["src/a.ts"]);
    wrapper.unmount();
  });

  it("shows a row's file history in the graph: a staged rename's old path, none for a new file", async () => {
    const { wrapper, calls } = await mountScreen({
      changes: {
        // src/moved.ts and src/fresh.ts were edited again after `git mv` and `git add`.
        unstaged: [...unstagedFiles(), changedFile("src/moved.ts"), changedFile("src/fresh.ts")],
        staged: [
          changedFile("src/moved.ts", { status: "renamed", oldPath: "src/old.ts" }),
          changedFile("src/fresh.ts", { status: "added", deletions: 0 }),
        ],
      },
    });
    const menuOn = async (list: "unstaged" | "staged", path: string) => {
      await wrapper.get(`[data-list="${list}"][data-path="${path}"]`).trigger("contextmenu");
      await nextTick();
    };
    // An untracked file and a file the commit adds have no history yet, edited or not.
    await menuOn("unstaged", "src/new.md");
    expect(wrapper.find('[data-testid="menu-copy-path"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="menu-history"]').exists()).toBe(false);
    await menuOn("staged", "src/fresh.ts");
    expect(wrapper.find('[data-testid="menu-history"]').exists()).toBe(false);
    await menuOn("unstaged", "src/fresh.ts");
    expect(wrapper.find('[data-testid="menu-history"]').exists()).toBe(false);
    // The edit of a staged rename lists the commits under the name before the rename.
    await menuOn("unstaged", "src/moved.ts");
    await wrapper.get('[data-testid="menu-history"]').trigger("click");
    await settled();
    expect(useGraphStore().filters.path).toBe("src/old.ts");
    useGraphStore().setPath("");
    await settled();
    await menuOn("staged", "src/moved.ts");
    await wrapper.get('[data-testid="menu-history"]').trigger("click");
    await settled();
    expect(useGraphStore().filters.path).toBe("src/old.ts");
    expect(useShellStore().layoutMode).toBe("graph");
    // The open repository's own changes open no other.
    expect(of(calls, "open_repository")).toHaveLength(1);
    const walk = of(calls, "walk_commits").at(-1);
    expect((walk?.args["options"] as { filter?: unknown }).filter).toEqual({
      paths: ["src/old.ts"],
    });
    wrapper.unmount();
  });

  it("finds over the Unstaged list and then the Staged one, opening the other list's file", async () => {
    const { wrapper } = await mountScreen({
      changes: { unstaged: [changedFile("src/a.ts")], staged: [changedFile("src/c.ts")] },
    });
    const changes = useChangesStore();
    const find = useFindStore();
    expect(changes.selected).toEqual({ list: "unstaged", path: "src/a.ts" });
    // Ctrl F on the screen opens the bar with its field focused.
    press("f", { ctrlKey: true });
    await settled();
    const bar = wrapper.get('[data-testid="find-bar"]');
    expect(document.activeElement).toBe(bar.get("input").element);
    find.setQuery("new()");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settled();
    expect(bar.get('[data-testid="find-count"]').text()).toBe("1 of 2");
    press("F3");
    await settled();
    await nextTick();
    expect(changes.selected).toEqual({ list: "staged", path: "src/c.ts" });
    expect(bar.get('[data-testid="find-count"]').text()).toBe("2 of 2");
    const current = wrapper.findAll(".bg-find-current").map((span) => span.text());
    expect(current.join("")).toBe("new()");
    wrapper.unmount();
  });

  it("keeps staging with s while git answers, and holds the rows while a commit waits", async () => {
    const gate = writeGate();
    const { wrapper, calls } = await mountScreen({ writeGate: gate });
    const changes = useChangesStore();
    (wrapper.get('[data-list="unstaged"][data-path="src/a.ts"]').element as HTMLElement).focus();
    press("s");
    await nextTick();
    // The file moved before git answered, and the row that took its place has the focus.
    expect(wrapper.find('[data-list="unstaged"][data-path="src/a.ts"]').exists()).toBe(false);
    expect(wrapper.find('[data-list="staged"][data-path="src/a.ts"]').exists()).toBe(true);
    await nextTick();
    expect(document.activeElement?.getAttribute("data-path")).toBe("src/b.ts");
    press("s");
    await nextTick();
    expect(wrapper.find('[data-list="unstaged"][data-path="src/b.ts"]').exists()).toBe(false);
    const rows = () => wrapper.findAll('[data-list="unstaged"], [data-list="staged"]');
    expect(rows().every((row) => row.attributes("aria-disabled") === undefined)).toBe(true);
    expect(gate.waiting).toEqual(["stage_paths"]);
    // A commit waits for both stages and keeps the rows inert until it ran.
    changes.setDraft({ subject: "feat: two" });
    const committing = changes.commit();
    await nextTick();
    expect(rows().every((row) => row.attributes("aria-disabled") === "true")).toBe(true);
    gate.release();
    await settled();
    gate.release();
    await settled();
    expect(gate.waiting).toEqual(["commit"]);
    gate.release();
    expect(await committing).toBe(true);
    await changes.settled();
    await nextTick();
    expect(of(calls, "stage_paths").map((call) => call.args["paths"])).toEqual([
      ["src/a.ts"],
      ["src/b.ts"],
    ]);
    expect(of(calls, "commit")).toHaveLength(1);
    expect(rows().every((row) => row.attributes("aria-disabled") === undefined)).toBe(true);
    wrapper.unmount();
  });

  it("confirms a discard naming the files, the untracked one as deleted, then discards", async () => {
    const { wrapper, calls } = await mountScreen();
    await wrapper.get('[data-testid="discard-all"]').trigger("click");
    await nextTick();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain("Discard 3 files?");
    expect(dialog.text()).toContain(
      "The unstaged changes to src/a.ts, src/b.ts and src/new.md are lost, and new.md is deleted: it is not tracked yet.",
    );
    expect(dialog.text()).toContain("Discarded changes cannot be recovered.");
    expect(wrapper.get('[data-testid="dialog-confirm"]').text()).toBe("Discard 3 files");
    await wrapper.get('[data-testid="dialog-cancel"]').trigger("click");
    await nextTick();
    expect(of(calls, "discard_paths")).toHaveLength(0);
    // Backspace on the selected untracked file: one file, deleted.
    useChangesStore().select("unstaged", "src/new.md");
    await nextTick();
    press("Backspace");
    await nextTick();
    const one = wrapper.get('[role="dialog"]');
    expect(one.text()).toContain("Discard 1 file?");
    expect(one.text()).toContain("new.md is deleted: it is not tracked yet.");
    expect(one.text()).not.toContain("unstaged changes");
    // The screen's keys stay out of the dialog: j does not move, s does not stage.
    press("j");
    press("s");
    await settled();
    expect(of(calls, "stage_paths")).toHaveLength(0);
    expect(wrapper.get('[data-testid="changes-path"]').text()).toBe("src/new.md");
    await wrapper.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "discard_paths")[0]?.args).toMatchObject({
      tracked: [],
      untracked: ["src/new.md"],
    });
    expect(wrapper.findAll('[data-list="unstaged"]')).toHaveLength(2);
    wrapper.unmount();
  });

  it("confirms a hunk discard with its range and applies it in reverse", async () => {
    const { wrapper, calls } = await mountScreen();
    await wrapper.get('[data-testid="hunk-discard"]').trigger("click");
    await nextTick();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain("Discard hunk?");
    expect(dialog.text()).toContain("The hunk at @@ -1,2 +1,3 @@ of src/a.ts is lost.");
    await wrapper.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "apply_selection")[0]?.args["target"]).toBe("discard");
    wrapper.unmount();
  });

  it("shows the empty sentence on a clean tree with the commit button disabled", async () => {
    const { wrapper } = await mountScreen({ changes: { unstaged: [], staged: [] } });
    expect(wrapper.get('[data-testid="changes-empty"]').text()).toBe(
      "Nothing to commit, the working tree is clean.",
    );
    expect(wrapper.get('[data-testid="changes-viewer-empty"]').text()).toContain(
      "let an agent, and they show up here.",
    );
    const header = wrapper.get('[data-testid="panel-header"]');
    expect(header.get('[data-testid="panel-header-title"]').text()).toBe("Changes");
    expect(header.get('[data-testid="panel-header-count"]').text()).toBe("0");
    expect(wrapper.get('[data-testid="commit-button"]').attributes("disabled")).toBeDefined();
    // The whole box is inert on a clean tree; the viewer has no header.
    expect(wrapper.get('[data-testid="commit-subject"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="commit-body"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="changes-viewer"] header').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows a failed diff in the lists panel with Try again", async () => {
    const { wrapper, calls } = await mountScreen({ failDiff: true });
    const banner = wrapper.get('[data-testid="changes-load-failed"]');
    expect(banner.text()).toContain("Couldn't read the working tree.");
    expect(wrapper.findAll('[data-testid="tree-row"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="changes-viewer-failed"]').exists()).toBe(true);
    const before = of(calls, "diff").length;
    await banner.get("button").trigger("click");
    await settled();
    expect(of(calls, "diff").length).toBe(before + 2);
    wrapper.unmount();
  });

  it("shows git's output in the banner when a hunk is refused, and reloads", async () => {
    const { wrapper, calls } = await mountScreen({ failStaging: true });
    await wrapper.get('[data-testid="hunk-stage"]').trigger("click");
    await settled();
    const banner = wrapper.get('[data-testid="changes-failed"]');
    expect(banner.text()).toContain("git refused the hunk of src/a.ts");
    expect(banner.text()).toContain("patch does not apply");
    const before = of(calls, "diff").length;
    await banner.get("button").trigger("click");
    await settled();
    expect(of(calls, "diff").length).toBe(before + 2);
    // Reload dismisses the failure too.
    expect(wrapper.find('[data-testid="changes-failed"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("commits with Ctrl+Enter from the subject, clears the box and reads Amend when amending", async () => {
    const { wrapper, calls } = await mountScreen();
    const subject = wrapper.get('[data-testid="commit-subject"]');
    expect(wrapper.get('[data-testid="commit-author"]').text()).toBe("Iker Z. <iker@x>");
    expect(wrapper.get('[data-testid="commit-button"]').attributes("disabled")).toBeDefined();
    await subject.setValue("feat: thing");
    await wrapper.get('[data-testid="commit-body"]').setValue("why");
    expect(wrapper.get('[data-testid="commit-button"]').attributes("disabled")).toBeUndefined();
    // Enter alone stays in the field; the commit key is Ctrl+Enter.
    await subject.trigger("keydown", { key: "Enter" });
    await settled();
    expect(of(calls, "commit")).toHaveLength(0);
    await subject.trigger("keydown", { key: "Enter", ctrlKey: true });
    await settled();
    expect(of(calls, "commit")[0]?.args["request"]).toEqual({
      message: "feat: thing\n\nwhy",
      amend: false,
      signoff: false,
    });
    expect((subject.element as HTMLInputElement).value).toBe("");
    expect(wrapper.findAll('[data-list="staged"]')).toHaveLength(0);
    // Amend borrows HEAD's message and renames the button.
    const amend = wrapper.get('[data-testid="commit-amend"]');
    expect(amend.attributes("aria-label")).toBe("Amend last commit");
    expect(amend.attributes("aria-pressed")).toBe("false");
    await amend.trigger("click");
    await nextTick();
    expect(amend.attributes("aria-pressed")).toBe("true");
    expect((subject.element as HTMLInputElement).value).toBe("fix(auth): commit 0");
    expect(wrapper.get('[data-testid="commit-button"]').text()).toBe("Amend");
    expect(wrapper.get('[data-testid="commit-author"]').text()).toBe("Amends 0000000 · Iker Z.");
    wrapper.unmount();
  });

  it("signs off through its icon toggle, and offers no amend on an unborn branch", async () => {
    const { wrapper, calls } = await mountScreen({ commitContext: { unborn: true } });
    const signoff = wrapper.get('[data-testid="commit-signoff"]');
    expect(signoff.attributes("aria-label")).toBe("Sign off");
    expect(signoff.attributes("data-tooltip")).toBe("Sign off");
    expect(signoff.attributes("aria-pressed")).toBe("false");
    expect(wrapper.get('[data-testid="commit-amend"]').attributes("disabled")).toBeDefined();
    await signoff.trigger("click");
    await nextTick();
    expect(signoff.attributes("aria-pressed")).toBe("true");
    const subject = wrapper.get('[data-testid="commit-subject"]');
    await subject.setValue("feat: first");
    await subject.trigger("keydown", { key: "Enter", ctrlKey: true });
    await settled();
    expect(of(calls, "commit")[0]?.args["request"]).toEqual({
      message: "feat: first",
      amend: false,
      signoff: true,
    });
    wrapper.unmount();
  });

  it("draws each file's kind in the lists, until Appearance turns the icons off", async () => {
    const { wrapper } = await mountScreen();
    const rows = wrapper.findAll('[data-list="unstaged"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.find('[data-testid="tree-row-icon"]').exists()).toBe(true);
    await useSettingsStore().update("fileIcons", false);
    await nextTick();
    expect(wrapper.find('[data-testid="tree-row-icon"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("counts a subject past 72 characters and keeps the message when the hook refuses", async () => {
    const { wrapper } = await mountScreen({ failCommit: true });
    const subject = wrapper.get('[data-testid="commit-subject"]');
    await subject.setValue("x".repeat(80));
    expect(wrapper.get('[data-testid="commit-subject-over"]').text()).toBe("80 of 72 characters");
    await wrapper.get('[data-testid="commit-button"]').trigger("submit");
    await settled();
    expect((subject.element as HTMLInputElement).value).toBe("x".repeat(80));
    const banner = wrapper.get('[data-testid="changes-failed"]');
    expect(banner.text()).toContain("The commit was not made.");
    expect(banner.text()).toContain("commit-msg hook");
    wrapper.unmount();
  });
});

describe("ChangesLayout, commit and push", () => {
  const remote = (name: string): Remote => ({
    name,
    fetchUrl: `https://example.com/${name}/r.git`,
    pushUrl: `https://example.com/${name}/r.git`,
    fetchedAt: null,
  });
  const main = (over: Partial<GitRef> = {}): GitRef => ({
    name: "main",
    fullName: "refs/heads/main",
    kind: "local-branch",
    target: fakeCommit(0).hash,
    isCurrent: true,
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    worktree: "/r",
    message: null,
    committedAt: fakeCommit(0).committer.time,
    ...over,
  });
  const commitPush = (target: { trigger: (event: string, init: object) => Promise<void> }) =>
    target.trigger("keydown", { key: "Enter", ctrlKey: true, shiftKey: true });
  const lastToast = () => useToastsStore().toasts.at(-1);
  const pushRequest = (setUpstream: boolean, branch = "main", remoteName = "origin") => ({
    remote: remoteName,
    branch,
    tag: null,
    delete: false,
    setUpstream,
    forceWithLease: false,
  });

  it("commits and pushes once with Ctrl Shift Enter, and with Ctrl Enter while Push after commit is pressed", async () => {
    const { wrapper, calls } = await mountScreen({ refs: [main()], remotes: [remote("origin")] });
    const subject = wrapper.get('[data-testid="commit-subject"]');
    const toggle = wrapper.get('[data-testid="commit-push"]');
    expect(toggle.attributes("aria-label")).toBe("Push after commit");
    expect(toggle.attributes("aria-pressed")).toBe("false");
    expect(wrapper.get('[data-testid="commit-button"]').text()).toBe("Commit");
    await subject.setValue("feat: thing");
    await commitPush(subject);
    await settled();
    expect(of(calls, "commit")).toHaveLength(1);
    expect(of(calls, "push")[0]?.args["request"]).toEqual(pushRequest(false));
    expect(lastToast()?.key).toBe("remotes.pushed");
    expect(useSettingsStore().values.pushAfterCommit).toBe(false);
    // Pressed, the toggle is remembered and the button and Ctrl Enter push too.
    await toggle.trigger("click");
    await nextTick();
    expect(toggle.attributes("aria-pressed")).toBe("true");
    expect(useSettingsStore().values.pushAfterCommit).toBe(true);
    expect(wrapper.get('[data-testid="commit-button"]').text()).toBe("Commit and push");
    await wrapper.get('[data-testid="commit-amend"]').trigger("click");
    await nextTick();
    expect(wrapper.get('[data-testid="commit-button"]').text()).toBe("Amend and push");
    await subject.trigger("keydown", { key: "Enter", ctrlKey: true });
    await settled();
    expect(of(calls, "commit")).toHaveLength(2);
    expect(of(calls, "commit")[1]?.args["request"]).toMatchObject({ amend: true });
    expect(of(calls, "push")).toHaveLength(2);
    wrapper.unmount();
  });

  it("publishes a branch without upstream to the only remote", async () => {
    const { wrapper, calls } = await mountScreen({ remotes: [remote("origin")] });
    const subject = wrapper.get('[data-testid="commit-subject"]');
    await subject.setValue("feat: thing");
    await commitPush(subject);
    await settled();
    expect(of(calls, "push")[0]?.args["request"]).toEqual(pushRequest(true));
    wrapper.unmount();
  });

  it("opens the push dialog once the commit is made when several remotes could take the branch", async () => {
    const { wrapper, calls } = await mountScreen({
      remotes: [remote("origin"), remote("upstream")],
    });
    const subject = wrapper.get('[data-testid="commit-subject"]');
    await subject.setValue("feat: thing");
    await commitPush(subject);
    await settled();
    expect(of(calls, "commit")).toHaveLength(1);
    expect(of(calls, "push")).toHaveLength(0);
    expect(useRemotesStore().prompt).toEqual({ kind: "push", branch: "main" });
    wrapper.unmount();
  });

  it("refuses on a detached HEAD before committing, and leaves Ctrl Enter a plain commit", async () => {
    const head: GitRef = {
      ...main({ isCurrent: false }),
      name: "HEAD",
      fullName: "HEAD",
      kind: "head",
    };
    const { wrapper, calls } = await mountScreen({
      refs: [head, main({ isCurrent: false })],
      remotes: [remote("origin")],
      detachedHead: true,
    });
    await useSettingsStore().update("pushAfterCommit", true);
    await nextTick();
    const toggle = wrapper.get('[data-testid="commit-push"]');
    expect(toggle.attributes("disabled")).toBeUndefined();
    expect(toggle.attributes("aria-disabled")).toBe("true");
    expect(toggle.attributes("aria-pressed")).toBe("true");
    expect(toggle.attributes("data-tooltip")).toBe("A detached HEAD has no branch to push.");
    expect(toggle.attributes("aria-description")).toBe("A detached HEAD has no branch to push.");
    expect(wrapper.get('[data-testid="commit-button"]').text()).toBe("Commit");
    // A press does nothing: the setting stays as it is.
    await toggle.trigger("click");
    expect(useSettingsStore().values.pushAfterCommit).toBe(true);
    const subject = wrapper.get('[data-testid="commit-subject"]');
    await subject.setValue("feat: thing");
    await commitPush(subject);
    await settled();
    expect(of(calls, "commit")).toHaveLength(0);
    expect(lastToast()?.key).toBe("changes.pushRefused.detached");
    await subject.trigger("keydown", { key: "Enter", ctrlKey: true });
    await settled();
    expect(of(calls, "commit")).toHaveLength(1);
    expect(of(calls, "push")).toHaveLength(0);
    wrapper.unmount();
  });

  it("keeps the commit when its push fails, with git's output and Push again", async () => {
    const { wrapper, calls } = await mountScreen({
      refs: [main()],
      remotes: [remote("origin")],
      rootIsPath: true,
      networkErrors: {
        "/r": {
          code: "git.cli_failed",
          message: "git push failed",
          detail:
            "fatal: unable to access 'https://example.com/origin/r.git/': Could not resolve host",
        },
      },
    });
    const subject = wrapper.get('[data-testid="commit-subject"]');
    await subject.setValue("feat: thing");
    await commitPush(subject);
    await settled();
    expect(of(calls, "commit")).toHaveLength(1);
    expect((subject.element as HTMLInputElement).value).toBe("");
    const toast = lastToast();
    expect(toast?.kind).toBe("error");
    expect(toast?.key).toBe("remotes.pushFailed");
    expect(toast?.output).toContain("Could not resolve host");
    expect(toast?.actionKey).toBe("remotes.pushAgain");
    toast?.onAction?.();
    await settled();
    expect(of(calls, "push")).toHaveLength(2);
    expect(of(calls, "push")[1]?.args["request"]).toEqual(pushRequest(false));
    // Once another repository is open, the toast's Push again says so and pushes nothing.
    const again = lastToast();
    await useRepoStore().open("/other");
    await settled();
    again?.onAction?.();
    await settled();
    expect(of(calls, "push")).toHaveLength(2);
    expect(lastToast()?.key).toBe("remotes.repositoryChanged");
    wrapper.unmount();
  });

  it("says a push the remote rejects needs a pull first, and offers Pull…", async () => {
    const { wrapper } = await mountScreen({
      refs: [main()],
      remotes: [remote("origin")],
      failNetwork: true,
    });
    const subject = wrapper.get('[data-testid="commit-subject"]');
    await subject.setValue("feat: thing");
    await commitPush(subject);
    await settled();
    const toast = lastToast();
    expect(toast?.key).toBe("remotes.pushRejected");
    expect(toast?.params).toEqual({ branch: "main", remote: "origin" });
    expect(toast?.actionKey).toBe("remotes.pullAction");
    toast?.onAction?.();
    expect(useRemotesStore().prompt).toEqual({ kind: "pull", branch: "main" });
    wrapper.unmount();
  });

  it("disables Push after commit while an amend would rewrite a commit the upstream holds", async () => {
    const { wrapper } = await mountScreen({
      refs: [main({ ahead: 0 })],
      remotes: [remote("origin")],
    });
    const toggle = wrapper.get('[data-testid="commit-push"]');
    expect(toggle.attributes("aria-disabled")).toBeUndefined();
    await wrapper.get('[data-testid="commit-amend"]').trigger("click");
    await nextTick();
    expect(toggle.attributes("aria-disabled")).toBe("true");
    expect(toggle.attributes("data-tooltip")).toBe(
      "The commit you amend is on the remote already: pushing its replacement needs a forced push.",
    );
    wrapper.unmount();
  });
});

describe("ChangesLayout, commit and push around other work", () => {
  const origin: Remote = {
    name: "origin",
    fetchUrl: "https://example.com/origin/r.git",
    pushUrl: "https://example.com/origin/r.git",
    fetchedAt: null,
  };
  const tracking = (ahead: number | null = 1): GitRef => ({
    name: "main",
    fullName: "refs/heads/main",
    kind: "local-branch",
    target: fakeCommit(0).hash,
    isCurrent: true,
    upstream: "origin/main",
    ahead,
    behind: 0,
    worktree: "/r",
    message: null,
    committedAt: fakeCommit(0).committer.time,
  });
  const commitPush = async (subject: ReturnType<VueWrapper["get"]>) => {
    await subject.setValue("feat: thing");
    await subject.trigger("keydown", { key: "Enter", ctrlKey: true, shiftKey: true });
  };

  it("commits at once and pushes once a running fetch ends", async () => {
    const { wrapper, calls } = await mountScreen({
      refs: [tracking()],
      remotes: [origin],
      networkDelayMs: 400,
    });
    void useRemotesStore().fetch("origin", false);
    await settled();
    await commitPush(wrapper.get('[data-testid="commit-subject"]'));
    await settled();
    expect(of(calls, "commit")).toHaveLength(1);
    expect(of(calls, "push")).toHaveLength(0);
    expect(useToastsStore().toasts.some((toast) => toast.key === "remotes.pushWaits")).toBe(true);
    await vi.waitFor(() => expect(of(calls, "push")).toHaveLength(1), { timeout: 3000 });
    // The push ends inside the test: its toast would land in the next test's store otherwise.
    await vi.waitFor(
      () =>
        expect(useToastsStore().toasts.some((toast) => toast.key === "remotes.pushed")).toBe(true),
      { timeout: 3000 },
    );
    wrapper.unmount();
  });

  it("pushes nothing when another repository opened while the commit ran", async () => {
    const gate = writeGate();
    const { wrapper, calls } = await mountScreen({
      refs: [tracking()],
      remotes: [origin],
      writeGate: gate,
      rootIsPath: true,
    });
    await commitPush(wrapper.get('[data-testid="commit-subject"]'));
    // Waited for, not counted in turns: under a loaded test run the steps take longer.
    await vi.waitFor(() => expect(gate.waiting).toEqual(["commit"]));
    await useRepoStore().open("/other");
    await settled();
    gate.release();
    await vi.waitFor(() =>
      expect(useToastsStore().toasts.at(-1)?.key).toBe("changes.committedNotPushed"),
    );
    expect(of(calls, "push")).toHaveLength(0);
    wrapper.unmount();
  });

  it("says an amended commit the remote holds needs a forced push, without Pull…", async () => {
    const { wrapper } = await mountScreen({
      refs: [tracking(null)],
      remotes: [origin],
      failNetwork: true,
    });
    await wrapper.get('[data-testid="commit-amend"]').trigger("click");
    await nextTick();
    const subject = wrapper.get('[data-testid="commit-subject"]');
    await subject.trigger("keydown", { key: "Enter", ctrlKey: true, shiftKey: true });
    await settled();
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.key).toBe("remotes.pushRejectedAmend");
    expect(toast?.onAction).toBeUndefined();
    wrapper.unmount();
  });
});
