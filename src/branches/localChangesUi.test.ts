// "Local changes in the way" and what follows it: the dialog's ways through for a switch, a merge,
// a rebase and a pull, the banner of a stash git kept until the user keeps or drops it, and the
// operation banner's line while a stopped merge holds the changes aside.

import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { AppError } from "@/ipc/errors";
import type { Conflict, Ref as GitRef } from "@/ipc/schemas";
import { useLocalChangesStore, type LocalChangesPrompt } from "@/stores/localChanges";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useSequencerStore } from "@/stores/sequencer";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useStashStore } from "@/stores/stash";
import { useToastsStore } from "@/stores/toasts";
import {
  fakeBackend,
  fakeCommit,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import KeptStashBanner from "./KeptStashBanner.vue";
import LocalChangesDialog from "./LocalChangesDialog.vue";
import OperationBanner from "./OperationBanner.vue";

const STASH = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";

const conflicts: Conflict[] = [
  { path: "src/a.ts", kind: "both-modified" },
  { path: "docs/b.md", kind: "both-modified" },
];

function stashRef(hash: string): GitRef {
  return {
    name: "stash@{0}",
    fullName: "refs/stash",
    kind: "stash",
    target: hash,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: "autostash",
    committedAt: null,
  };
}

const main: GitRef = {
  name: "main",
  fullName: "refs/heads/main",
  kind: "local-branch",
  target: fakeCommit(0).hash,
  isCurrent: true,
  upstream: null,
  ahead: null,
  behind: null,
  worktree: null,
  message: null,
  committedAt: null,
};

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

async function open(options: FakeBackendOptions = {}): Promise<Call[]> {
  const calls = fakeBackend(options);
  await useRepoStore().open("/r");
  await settled();
  return calls;
}

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);

const SWITCH_REFUSAL =
  "error: Your local changes to the following files would be overwritten by checkout:\n" +
  ["a", "b", "c", "d", "e", "f", "g"].map((name) => `\tsrc/${name}.ts`).join("\n") +
  "\nPlease commit your changes or stash them before you switch branches.\nAborting";

const UNTRACKED_SWITCH_REFUSAL =
  "error: The following untracked working tree files would be overwritten by checkout:\n\tnotes.md\nPlease move or remove them before you switch branches.\nAborting";

function asked(prompt: Partial<LocalChangesPrompt>): ReturnType<typeof vi.fn> {
  const run = vi.fn(() => Promise.resolve());
  useLocalChangesStore().ask({
    operation: "switch",
    target: "develop",
    detail: SWITCH_REFUSAL,
    run,
    ...prompt,
  });
  return run;
}

/** The dialog's buttons by their words, the output's toggle left out. */
const buttons = (wrapper: ReturnType<typeof mountWithI18n>) =>
  wrapper
    .findAll('[role="dialog"] button')
    .map((button) => button.text())
    .filter((text) => text !== "" && !text.includes("git output"));

/** The dialog's sentence: the first of what its accessible description names. */
function body(wrapper: ReturnType<typeof mountWithI18n>): string {
  const ids = wrapper.get('[role="dialog"]').attributes("aria-describedby")?.split(" ") ?? [];
  expect(ids.length).toBeGreaterThan(0);
  return document.getElementById(ids[0] ?? "")?.textContent ?? "";
}

/** Everything the dialog's accessible description names, in order. */
function description(wrapper: ReturnType<typeof mountWithI18n>): string[] {
  const ids = wrapper.get('[role="dialog"]').attributes("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "");
}

describe("Local changes in the way", () => {
  it("names five files and counts the rest, and carries the changes with the primary", async () => {
    await open({ refs: [main] });
    const run = asked({});
    const wrapper = mountWithI18n(LocalChangesDialog, { attachTo: document.body });
    await nextTick();
    expect(body(wrapper)).toBe("git won't switch to develop while these files have changes:");
    const files = wrapper.get('[data-testid="local-changes-files"]').findAll("li");
    expect(files.map((file) => file.text())).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "and 2 more",
    ]);
    expect(buttons(wrapper)).toEqual(["Cancel", "Leave them in a stash", "Bring my changes"]);
    // ↵ runs the way through: the primary has the focus.
    const confirm = wrapper.get('[data-testid="dialog-confirm"]');
    expect(document.activeElement).toBe(confirm.element);
    await confirm.trigger("click");
    await flushPromises();
    expect(run).toHaveBeenCalledWith("carry");
    expect(useLocalChangesStore().prompt).toBeNull();
    wrapper.unmount();
  });

  it("leaves the changes in a stash, and Esc cancels", async () => {
    await open({ refs: [main] });
    const leave = asked({});
    const wrapper = mountWithI18n(LocalChangesDialog, { attachTo: document.body });
    await nextTick();
    await wrapper.get('[data-testid="local-changes-leave"]').trigger("click");
    await flushPromises();
    expect(leave).toHaveBeenCalledWith("leave");
    const cancelled = asked({});
    await nextTick();
    await wrapper.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(cancelled).not.toHaveBeenCalled();
    expect(useLocalChangesStore().prompt).toBeNull();
    wrapper.unmount();
  });

  it("puts leaving the changes first when untracked files are in a switch's way", async () => {
    await open({ refs: [main] });
    const run = asked({ detail: UNTRACKED_SWITCH_REFUSAL });
    const wrapper = mountWithI18n(LocalChangesDialog, { attachTo: document.body });
    await nextTick();
    expect(body(wrapper)).toBe(
      "git won't switch to develop while these untracked files are in the way:",
    );
    expect(buttons(wrapper)).toEqual(["Cancel", "Bring my changes", "Leave them in a stash"]);
    const confirm = wrapper.get('[data-testid="dialog-confirm"]');
    expect(document.activeElement).toBe(confirm.element);
    await confirm.trigger("click");
    await flushPromises();
    expect(run).toHaveBeenCalledWith("leave");
    const carry = asked({ detail: UNTRACKED_SWITCH_REFUSAL });
    await nextTick();
    await wrapper.get('[data-testid="local-changes-carry"]').trigger("click");
    await flushPromises();
    expect(carry).toHaveBeenCalledWith("carry");
    wrapper.unmount();
  });

  it("sets the changes aside for a merge, and names no file for a rebase", async () => {
    await open({ refs: [main] });
    const merge = asked({
      operation: "merge",
      detail:
        "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\nAborting",
    });
    const wrapper = mountWithI18n(LocalChangesDialog, { attachTo: document.body });
    await nextTick();
    expect(body(wrapper)).toBe("git won't merge develop into main while these files have changes:");
    expect(buttons(wrapper)).toEqual(["Cancel", "Set them aside and merge"]);
    await wrapper.get('[data-testid="dialog-confirm"]').trigger("click");
    await flushPromises();
    expect(merge).toHaveBeenCalledWith("aside");
    asked({
      operation: "rebase",
      detail:
        "error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.",
    });
    await nextTick();
    expect(body(wrapper)).toBe(
      "git won't rebase main onto develop while the working tree has changes.",
    );
    expect(wrapper.find('[data-testid="local-changes-files"]').exists()).toBe(false);
    expect(buttons(wrapper)).toEqual(["Cancel", "Set them aside and rebase"]);
    wrapper.unmount();
  });

  it("names only the untracked files when they block a merge that changed files are in the way of too", async () => {
    await open({ refs: [main] });
    asked({
      operation: "merge",
      detail:
        "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\nPlease commit your changes or stash them before you merge.\nerror: The following untracked working tree files would be overwritten by merge:\n\tnotes/tile-cache.md\nPlease move or remove them before you merge.\nAborting",
    });
    const wrapper = mountWithI18n(LocalChangesDialog, { attachTo: document.body });
    await nextTick();
    expect(body(wrapper)).toBe(
      "git won't merge develop into main while these untracked files are in the way:",
    );
    expect(
      wrapper
        .get('[data-testid="local-changes-files"]')
        .findAll("li")
        .map((file) => file.text()),
    ).toEqual(["notes/tile-cache.md"]);
    expect(buttons(wrapper)).toEqual(["Close"]);
    wrapper.unmount();
  });

  it("reads merge-ort's one-line list against the staged files", async () => {
    await open({
      refs: [main],
      changes: {
        unstaged: [],
        staged: [changedFile("docs/release notes.md"), changedFile("u.txt")],
      },
    });
    asked({
      operation: "merge",
      detail:
        "error: Your local changes to the following files would be overwritten by merge:\n  docs/release notes.md u.txt\nMerge with strategy ort failed.",
    });
    const wrapper = mountWithI18n(LocalChangesDialog, { attachTo: document.body });
    await settled();
    expect(
      wrapper
        .get('[data-testid="local-changes-files"]')
        .findAll("li")
        .map((file) => file.text()),
    ).toEqual(["docs/release notes.md", "u.txt"]);
    wrapper.unmount();
  });

  it("says the working tree has changes when a pull's refusal names no file", async () => {
    await open({ refs: [main] });
    asked({
      operation: "pull",
      target: "origin/main",
      detail:
        "error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.",
    });
    const wrapper = mountWithI18n(LocalChangesDialog, { attachTo: document.body });
    await nextTick();
    expect(body(wrapper)).toBe(
      "git won't pull origin/main into main while the working tree has changes.",
    );
    expect(buttons(wrapper)).toEqual(["Cancel", "Set them aside and pull"]);
    wrapper.unmount();
  });

  it("offers Close alone for untracked files in a merge's way, with the focus, and git's output one click away", async () => {
    await open({ refs: [main] });
    const run = asked({
      operation: "merge",
      detail:
        "error: The following untracked working tree files would be overwritten by merge:\n\tnotes/tile-cache.md\nPlease move or remove them before you merge.\nAborting",
    });
    const wrapper = mountWithI18n(LocalChangesDialog, { attachTo: document.body });
    await nextTick();
    expect(body(wrapper)).toBe(
      "git won't merge develop into main while these untracked files are in the way:",
    );
    expect(wrapper.text()).toContain("Move or delete them, then try again.");
    // A screen reader hears the files and what to do with them after the sentence.
    expect(description(wrapper).slice(1)).toEqual([
      "notes/tile-cache.md",
      "Move or delete them, then try again.",
    ]);
    expect(wrapper.find('[data-testid="dialog-confirm"]').exists()).toBe(false);
    expect(buttons(wrapper)).toEqual(["Close"]);
    // ↵ closes: the one button has the focus, not the output's toggle.
    expect(document.activeElement).toBe(wrapper.get('[data-testid="dialog-cancel"]').element);
    expect(wrapper.find('[data-testid="local-changes-output"]').exists()).toBe(false);
    const toggle = wrapper.get('[data-testid="local-changes-output-toggle"]');
    await toggle.trigger("click");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(wrapper.get('[data-testid="local-changes-output"]').text()).toContain(
      "untracked working tree files",
    );
    // The next question opens with git's words folded.
    asked({ operation: "merge" });
    await nextTick();
    expect(wrapper.find('[data-testid="local-changes-output"]').exists()).toBe(false);
    await wrapper.get('[data-testid="dialog-cancel"]').trigger("click");
    await flushPromises();
    expect(run).not.toHaveBeenCalled();
    expect(useLocalChangesStore().prompt).toBeNull();
    wrapper.unmount();
  });

  it("pulls again with the changes set aside when git refuses a pull over them", async () => {
    const calls = await open({ refs: [main], localChangesIn: ["pull"] });
    const remotes = useRemotesStore();
    const request = { remote: null, branch: null, rebase: false, ffOnly: true, autostash: false };
    expect(await remotes.pull(request)).toBe(false);
    const localChanges = useLocalChangesStore();
    expect(localChanges.prompt).toMatchObject({ operation: "pull" });
    expect(useToastsStore().toasts.filter((toast) => toast.kind === "error")).toHaveLength(0);
    await localChanges.choose("aside");
    await settled();
    expect(
      of(calls, "pull").map((call) => (call.args["request"] as { autostash: boolean }).autostash),
    ).toEqual([false, true]);
  });

  it("names the remote branch a pull asked for", async () => {
    await open({ refs: [main], localChangesIn: ["pull"] });
    const request = {
      remote: "origin",
      branch: "feature/x",
      rebase: false,
      ffOnly: false,
      autostash: false,
    };
    await useRemotesStore().pull(request);
    expect(useLocalChangesStore().prompt).toMatchObject({
      operation: "pull",
      target: "origin/feature/x",
    });
  });
});

describe("the banner of a kept stash", () => {
  it("says the changes came back with conflicts, in place of the operation banner", async () => {
    await open({ refs: [main, stashRef(STASH)], conflicts });
    await useSequencerStore().load();
    useLocalChangesStore().keep("/r", STASH);
    const kept = mountWithI18n(KeptStashBanner, { attachTo: document.body });
    const operation = mountWithI18n(OperationBanner, { attachTo: document.body });
    await flushPromises();
    expect(kept.get('[data-testid="kept-stash-title"]').text()).toBe(
      "Your changes came back with conflicts · 2 files",
    );
    expect(kept.get('[data-testid="kept-stash-hint"]').text()).toBe(
      "They are still in a stash. Resolve the files and mark them.",
    );
    expect(kept.get('[data-testid="kept-stash-live"]').text()).toBe(
      "Your changes came back with conflicts · 2 files. They are still in a stash. Resolve the files and mark them.",
    );
    expect(operation.find('[data-testid="operation-banner"]').exists()).toBe(false);
    await kept.get('[data-testid="kept-stash-resolve"]').trigger("click");
    await flushPromises();
    expect(useShellStore().layoutMode).toBe("changes");
    expect(kept.find('[data-testid="kept-stash-keep"]').exists()).toBe(false);
    kept.unmount();
    operation.unmount();
  });

  it("shows a refused resolution under it", async () => {
    await open({ refs: [main, stashRef(STASH)], conflicts });
    const sequencer = useSequencerStore();
    await sequencer.load();
    useLocalChangesStore().keep("/r", STASH);
    sequencer.error = new AppError(
      "git.cli_failed",
      "git add failed",
      "fatal: unable to write new index file",
    );
    const wrapper = mountWithI18n(KeptStashBanner, { attachTo: document.body });
    await flushPromises();
    const failed = wrapper.get(
      '[data-testid="kept-stash-banner"] [data-testid="operation-failed"]',
    );
    expect(failed.text()).toContain("fatal: unable to write new index file");
    wrapper.unmount();
  });

  it("drops the stash once no conflict remains, confirmed in place", async () => {
    const calls = await open({ refs: [main, stashRef(STASH)] });
    const localChanges = useLocalChangesStore();
    localChanges.keep("/r", STASH);
    const wrapper = mountWithI18n(KeptStashBanner, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="kept-stash-title"]').text()).toBe("Your changes are back");
    await wrapper.get('[data-testid="kept-stash-drop"]').trigger("click");
    await nextTick();
    expect(useStashStore().sheetOpen).toBe(false);
    const dialog = wrapper.get('[data-testid="kept-stash-drop-dialog"]');
    expect(dialog.text()).toContain("Drop stash@{0}?");
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "stash_drop")[0]?.args["stash"]).toBe(STASH);
    expect(localChanges.kept).toBeNull();
    expect(wrapper.find('[data-testid="kept-stash-banner"]').exists()).toBe(false);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("stash.dropped");
    wrapper.unmount();
  });

  it("keeps the stash, handing the focus back, and offers no drop before the stash is listed", async () => {
    await open({ refs: [main] });
    const localChanges = useLocalChangesStore();
    localChanges.keep("/r", STASH);
    const wrapper = mountWithI18n(KeptStashBanner, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.find('[data-testid="kept-stash-drop"]').exists()).toBe(false);
    const keep = wrapper.get('[data-testid="kept-stash-keep"]');
    (keep.element as HTMLElement).focus();
    await keep.trigger("click");
    await flushPromises();
    expect(localChanges.kept).toBeNull();
    expect(wrapper.find('[data-testid="kept-stash-banner"]').exists()).toBe(false);
    expect(wrapper.emitted("released")).toHaveLength(1);
    wrapper.unmount();
  });

  it("goes when its stash leaves the list, but not for a listing that predates it", async () => {
    await open({ refs: [main] });
    const localChanges = useLocalChangesStore();
    localChanges.keep("/r", STASH);
    const repo = useRepoStore();
    // A listing taken before the stash was made lands after it: the banner stays.
    repo.refs = [main];
    await nextTick();
    expect(localChanges.kept).not.toBeNull();
    repo.refs = [main, stashRef(STASH)];
    await nextTick();
    repo.refs = [main];
    await nextTick();
    expect(localChanges.kept).toBeNull();
  });

  it("shows when the operation that held the changes ends and git kept them with conflicts", async () => {
    await open({ refs: [main], operation: "merge", conflicts: [], heldAside: STASH });
    // The shell's banners hold the store from the start.
    const localChanges = useLocalChangesStore();
    const sequencer = useSequencerStore();
    await sequencer.load();
    expect(sequencer.heldAside).toBe(STASH);
    // The merge is committed (from the commit box): git puts the changes back with a conflict
    // and keeps the stash.
    clearMocks();
    fakeBackend({
      refs: [main, stashRef(STASH)],
      operation: "none",
      conflicts: [conflicts[0]!],
      heldAside: null,
    });
    await sequencer.load();
    expect(localChanges.kept).toBeNull();
    useRepoStore().refs = [main, stashRef(STASH)];
    await settled();
    expect(localChanges.kept).toEqual({ root: "/r", stash: STASH });
  });

  it("toasts a stash git kept when the changes did not come back at all", async () => {
    await open({ refs: [main], operation: "rebase", heldAside: STASH });
    const localChanges = useLocalChangesStore();
    const sequencer = useSequencerStore();
    await sequencer.load();
    clearMocks();
    fakeBackend({ refs: [main, stashRef(STASH)], operation: "none", heldAside: null });
    await sequencer.load();
    useRepoStore().refs = [main, stashRef(STASH)];
    await settled();
    expect(localChanges.kept).toBeNull();
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "localChanges.stashKept",
      sticky: true,
      params: { hash: "c4d5e6f" },
    });
  });

  it("says when the changes a stopped merge holds aside come back", async () => {
    await open({ refs: [main], operation: "merge", conflicts, heldAside: STASH });
    await useSequencerStore().load();
    const wrapper = mountWithI18n(OperationBanner, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="operation-held-aside"]').text()).toBe(
      "Your other changes come back when the merge is committed or aborted.",
    );
    wrapper.unmount();
  });
});
