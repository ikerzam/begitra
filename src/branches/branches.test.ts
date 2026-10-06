import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import type { Conflict, Ref as GitRef } from "@/ipc/schemas";
import { useBranchesStore } from "@/stores/branches";
import { useChangesStore } from "@/stores/changes";
import { useRepoStore } from "@/stores/repo";
import { useSequencerStore } from "@/stores/sequencer";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useToastsStore } from "@/stores/toasts";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import BranchDialogs from "./BranchDialogs.vue";
import { validName } from "./names";
import OperationBanner from "./OperationBanner.vue";

const conflicts: Conflict[] = [
  { path: "src/a.ts", kind: "both-modified" },
  { path: "docs/b.md", kind: "deleted-by-them" },
];

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

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

const input = (wrapper: ReturnType<typeof mountWithI18n>, id: string) =>
  wrapper.get<HTMLInputElement>(`input[data-testid="${id}"]`);

describe("branch names", () => {
  it("accepts what git accepts and refuses the rest", () => {
    for (const good of ["main", "feature/tile-cache", "v2.3.1", "ünïcödé"]) {
      expect(validName(good), good).toBe(true);
    }
    for (const bad of ["", "-x", "a b", "a..b", "a~1", "a/", ".hidden", "a.lock", "a\\b"]) {
      expect(validName(bad), bad).toBe(false);
    }
  });
});

describe("BranchDialogs", () => {
  it("creates a branch from the dialog once the name is valid, checking it out by default", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    branches.ask({ kind: "create", start: "main", startLabel: "main" });
    await nextTick();
    const dialog = wrapper.get('[data-testid="branch-create-dialog"]');
    expect(dialog.text()).toContain("From main.");
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("disabled")).toBeDefined();
    await input(wrapper, "branch-name").setValue("bad name");
    await nextTick();
    expect(dialog.text()).toContain("Not a valid branch name.");
    await input(wrapper, "branch-name").setValue("feature/x");
    await nextTick();
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("disabled")).toBeUndefined();
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "branch_create")[0]?.args).toMatchObject({
      name: "feature/x",
      start: "main",
      checkout: true,
    });
    expect(branches.prompt).toBeNull();
    wrapper.unmount();
  });

  it("sets the upstream picked with the mouse, its list closing on it", async () => {
    const remote = (name: string) => ({
      name,
      fullName: `refs/remotes/${name}`,
      kind: "remote-branch" as const,
      target: "0".repeat(40),
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    });
    const calls = await open({ refs: [remote("origin/develop"), remote("origin/main")] });
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    branches.ask({ kind: "upstream", branch: "main", current: null });
    await nextTick();
    const dialog = wrapper.get('[data-testid="branch-upstream-dialog"]');
    const select = dialog.get('[data-testid="branch-upstream"]');
    await select.get('[data-testid="select-button"]').trigger("click");
    await select.get('[data-testid="option"][data-value="origin/main"]').trigger("click");
    await nextTick();
    expect(select.find('[data-testid="option-list"]').exists()).toBe(false);
    expect(select.get('[data-testid="select-button"]').text()).toBe("origin/main");
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "set_upstream")[0]?.args).toMatchObject({
      branch: "main",
      upstream: "origin/main",
    });
    wrapper.unmount();
  });

  it("resets with the chosen mode, destructive for hard", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    branches.ask({ kind: "reset", rev: "a".repeat(40), label: "aaaaaaa", branch: "main" });
    await nextTick();
    const dialog = wrapper.get('[data-testid="reset-dialog"]');
    expect(dialog.text()).toContain("Reset main to aaaaaaa?");
    expect(dialog.text()).toContain("The reflog keeps the previous HEAD for 90 days");
    expect(dialog.get('[data-testid="dialog-confirm"]').text()).toBe("Reset mixed");
    await dialog.get('[data-testid="radio-hard"] input').setValue(true);
    await nextTick();
    expect(dialog.get('[data-testid="dialog-confirm"]').text()).toBe("Reset hard");
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("data-variant")).toBe(
      "destructive",
    );
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "reset")[0]?.args).toMatchObject({ rev: "a".repeat(40), mode: "hard" });
    wrapper.unmount();
  });

  it("offers Delete anyway with git's refusal and the reflog note", async () => {
    const calls = await open({ unmergedBranch: true });
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    branches.ask({ kind: "delete", name: "develop", force: false, output: "" });
    await nextTick();
    expect(wrapper.get('[data-testid="branch-delete-dialog"]').text()).toContain("Delete develop?");
    await wrapper.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    await nextTick();
    const anyway = wrapper.get('[data-testid="branch-delete-dialog"]');
    expect(anyway.text()).toContain("Delete develop anyway?");
    expect(anyway.text()).toContain("reflog for 90 days");
    expect(anyway.text()).toContain("not fully merged");
    await anyway.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "branch_delete").map((call) => call.args["force"])).toEqual([false, true]);
    wrapper.unmount();
  });
});

describe("OperationBanner", () => {
  it("names the merge and its conflicts, disables Continue until resolved, aborts once confirmed", async () => {
    const calls = await open({
      operation: "merge",
      conflicts,
      commitContext: {
        operation: "merge",
        preparedMessage: "Merge branch 'develop'\n\n# Conflicts:",
      },
    });
    const sequencer = useSequencerStore();
    await sequencer.load();
    await useChangesStore().loadContext();
    const wrapper = mountWithI18n(OperationBanner, { attachTo: document.body });
    await flushPromises();
    const banner = wrapper.get('[data-testid="operation-banner"]');
    expect(banner.get('[data-testid="operation-title"]').text()).toBe(
      "Merging develop into main · 2 conflicts",
    );
    expect(banner.get('[data-testid="operation-hint"]').text()).toBe(
      "Resolve the files, mark them, then continue.",
    );
    expect(banner.get('[data-testid="operation-continue"]').attributes("disabled")).toBeDefined();
    expect(banner.find('[data-testid="operation-skip"]').exists()).toBe(false);
    // From the graph, "Resolve…" opens the changes screen.
    await banner.get('[data-testid="operation-resolve"]').trigger("click");
    await flushPromises();
    expect(useShellStore().layoutMode).toBe("changes");
    await banner.get('[data-testid="operation-abort"]').trigger("click");
    await nextTick();
    const dialog = wrapper.get('[data-testid="abort-dialog"]');
    expect(dialog.text()).toContain("Abort the merge?");
    expect(dialog.text()).toContain("The operation's changes are dropped");
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "sequencer")[0]?.args["action"]).toBe("abort");
    wrapper.unmount();
  });

  it("continues once every conflict is marked, and shows Skip for a rebase", async () => {
    const calls = await open({ operation: "rebase", conflicts: [] });
    const sequencer = useSequencerStore();
    await sequencer.load();
    const wrapper = mountWithI18n(OperationBanner, { attachTo: document.body });
    await flushPromises();
    const banner = wrapper.get('[data-testid="operation-banner"]');
    expect(banner.get('[data-testid="operation-title"]').text()).toBe("Rebasing main");
    expect(banner.get('[data-testid="operation-hint"]').text()).toContain("continue or abort");
    expect(banner.find('[data-testid="operation-skip"]').exists()).toBe(true);
    expect(banner.get('[data-testid="operation-continue"]').attributes("disabled")).toBeUndefined();
    await banner.get('[data-testid="operation-continue"]').trigger("click");
    await settled();
    expect(of(calls, "sequencer")[0]?.args["action"]).toBe("continue");
    wrapper.unmount();
  });
});

describe("Undo last commit", () => {
  const HASH = "c".repeat(40);
  const PARENT = "b".repeat(40);
  const LATER = "d".repeat(40);
  const ORIGIN = { name: "origin", fetchUrl: "/o", pushUrl: "/o", fetchedAt: null };
  const ref = (over: Partial<GitRef>): GitRef => ({
    name: "main",
    fullName: "refs/heads/main",
    kind: "local-branch",
    target: HASH,
    isCurrent: true,
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    worktree: "/r",
    message: null,
    committedAt: 1_700_000_000,
    ...over,
  });
  const head = (target = HASH) =>
    ref({ name: "HEAD", fullName: "HEAD", kind: "head", target, upstream: null, ahead: null });
  const lastToast = () => useToastsStore().toasts.at(-1);
  const moves = (calls: Call[]) => of(calls, "move_head").map((call) => call.args);

  /** The repository open on HASH, its parent PARENT; the fake reads `options` as it changes. */
  async function ready(over: FakeBackendOptions = {}) {
    const options: FakeBackendOptions = {
      refs: [head(), ref({})],
      remotes: [ORIGIN],
      commitContext: { headParents: [PARENT] },
      ...over,
    };
    const calls = await open(options);
    await useChangesStore().loadContext();
    return { calls, options };
  }

  it("moves HEAD to the parent only from the commit read, puts the message back, and redoes", async () => {
    const { calls } = await ready();
    const changes = useChangesStore();
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    expect(moves(calls)).toEqual([
      expect.objectContaining({ from: HASH, to: PARENT, branch: "refs/heads/main" }),
    ]);
    expect(of(calls, "reset")).toHaveLength(0);
    expect(changes.draft.subject).toBe("fix(auth): commit 0");
    expect(branches.undone).toEqual({
      root: "/r",
      branch: "refs/heads/main",
      hash: HASH,
      parent: PARENT,
      restored: "fix(auth): commit 0",
    });
    const toast = lastToast();
    expect(toast?.key).toBe("branches.undone");
    expect(toast?.params).toEqual({ hash: "ccccccc" });
    expect(toast?.actionKey).toBe("branches.redo");
    toast?.onAction?.();
    await settled();
    expect(moves(calls)[1]).toMatchObject({ from: PARENT, to: HASH, branch: "refs/heads/main" });
    // The message leaves the box with the redo: the commit holds it again.
    expect(changes.draft.subject).toBe("");
    expect(branches.undone).toBeNull();
    expect(lastToast()?.key).toBe("branches.redone");
  });

  it("clears with the redo a message whose body followed the subject without a blank line", async () => {
    await ready({ commitContext: { headParents: [PARENT], headMessage: "fix: one\nthe body" } });
    const changes = useChangesStore();
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    expect(changes.draft.body).toBe("the body");
    expect(await branches.redoUndone()).toBe(true);
    expect(changes.draft.subject).toBe("");
    expect(changes.draft.body).toBe("");
  });

  it("leaves a draft in the box and says the message was not put in it", async () => {
    const { calls } = await ready();
    const changes = useChangesStore();
    changes.setDraft({ subject: "wip: half a thought" });
    expect(await useBranchesStore().undoLastCommit()).toBe(true);
    expect(moves(calls)).toHaveLength(1);
    expect(changes.draft.subject).toBe("wip: half a thought");
    expect(lastToast()?.key).toBe("branches.undoneKeptDraft");
  });

  it("takes the template the box prefilled for an empty box", async () => {
    await ready({
      commitContext: { headParents: [PARENT], template: "feat: \n\n# Why, not what.\n" },
    });
    const changes = useChangesStore();
    expect(changes.draft.subject).toBe("feat:");
    expect(await useBranchesStore().undoLastCommit()).toBe(true);
    expect(changes.draft.subject).toBe("fix(auth): commit 0");
    expect(lastToast()?.key).toBe("branches.undone");
  });

  it("turns amend off: its borrowed message goes and the commit's comes back", async () => {
    await ready();
    const changes = useChangesStore();
    changes.setDraft({ amend: true });
    expect(changes.draft.subject).toBe("fix(auth): commit 0");
    expect(await useBranchesStore().undoLastCommit()).toBe(true);
    expect(changes.draft.amend).toBe(false);
    expect(changes.draft.subject).toBe("fix(auth): commit 0");
    expect(lastToast()?.key).toBe("branches.undone");
  });

  it("refuses a merge commit and a first commit before git runs", async () => {
    const { calls, options } = await ready({ commitContext: { headParents: [PARENT, LATER] } });
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(false);
    expect(lastToast()?.key).toBe("branches.undoRefused.merge");
    expect(lastToast()?.params).toEqual({ branch: "main" });
    options.commitContext = { headParents: [] };
    expect(await branches.undoLastCommit()).toBe(false);
    expect(lastToast()?.key).toBe("branches.undoRefused.root");
    expect(moves(calls)).toHaveLength(0);
  });

  it("refuses during a bisect and while the index holds conflicts", async () => {
    const { calls, options } = await ready({
      commitContext: { headParents: [PARENT], otherOperation: "bisect" },
    });
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(false);
    expect(lastToast()?.key).toBe("branches.undoRefused.bisect");
    options.commitContext = { headParents: [PARENT] };
    options.conflicts = conflicts;
    expect(await branches.undoLastCommit()).toBe(false);
    expect(lastToast()?.key).toBe("branches.undoRefused.conflicts");
    expect(moves(calls)).toHaveLength(0);
  });

  it("asks first when a remote holds the commit, and undoes once confirmed", async () => {
    const { calls } = await ready({ refs: [head(), ref({ ahead: 0 })] });
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    expect(await branches.undoLastCommit()).toBe(false);
    expect(branches.prompt).toEqual({
      kind: "undoCommit",
      hash: HASH,
      label: "ccccccc",
      remote: "origin",
    });
    await nextTick();
    const dialog = wrapper.get('[data-testid="undo-commit-dialog"]');
    expect(dialog.text()).toContain("origin");
    expect(dialog.text()).toContain("Revert");
    expect(dialog.text()).toContain("reflog");
    expect(moves(calls)).toHaveLength(0);
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(moves(calls)).toEqual([expect.objectContaining({ from: HASH, to: PARENT })]);
    expect(branches.prompt).toBeNull();
    wrapper.unmount();
  });

  it("does not ask for a local upstream, which no remote holds", async () => {
    const { calls } = await ready({ refs: [head(), ref({ upstream: "feature/x", ahead: 0 })] });
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    expect(branches.prompt).toBeNull();
    expect(moves(calls)).toHaveLength(1);
  });

  it("closes the dialog and changes nothing when HEAD moved before the confirmation", async () => {
    const { calls, options } = await ready({ refs: [head(), ref({ ahead: 0 })] });
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(false);
    // A commit made in a terminal while the dialog was open.
    options.refs = [head(LATER), ref({ target: LATER, ahead: 1 })];
    options.commitContext = { headParents: [HASH], head: LATER };
    expect(await branches.undoLastCommit({ confirmed: HASH })).toBe(false);
    expect(branches.prompt).toBeNull();
    expect(lastToast()?.key).toBe("branches.undoMoved");
    expect(moves(calls)).toHaveLength(0);
  });

  it("says HEAD moved when a commit lands between the plan and git, and changes nothing", async () => {
    const { calls } = await ready({ headMovesTo: LATER });
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(false);
    expect(moves(calls)).toHaveLength(1);
    expect(lastToast()?.key).toBe("branches.undoMoved");
    expect(useChangesStore().draft.subject).toBe("");
    expect(branches.undone).toBeNull();
  });

  it("refuses Redo on another branch at the same commit", async () => {
    const { calls, options } = await ready();
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    // `git switch other`, a branch at the commit the undo went to.
    options.refs = [
      head(PARENT),
      ref({ target: PARENT, isCurrent: false }),
      ref({ name: "other", fullName: "refs/heads/other", target: PARENT, upstream: null }),
    ];
    await useRepoStore().refreshRefs();
    expect(await branches.redoUndone()).toBe(false);
    expect(lastToast()?.key).toBe("branches.redoStale");
    expect(moves(calls)).toHaveLength(1);
  });

  it("refuses Redo in another repository", async () => {
    const { calls } = await ready({ rootIsPath: true });
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    await useRepoStore().open("/s");
    await settled();
    expect(await branches.redoUndone()).toBe(false);
    expect(lastToast()?.key).toBe("remotes.repositoryChanged");
    expect(moves(calls)).toHaveLength(1);
  });

  it("refuses Redo once HEAD moved since the undo, and forgets it", async () => {
    const { calls, options } = await ready();
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    const redo = lastToast();
    // A commit made since: HEAD is no longer where the undo left it.
    options.headMovesTo = LATER;
    redo?.onAction?.();
    await settled();
    expect(moves(calls)).toHaveLength(2);
    expect(lastToast()?.key).toBe("branches.redoStale");
    expect(branches.undone).toBeNull();
  });

  it("undoes only the commit the menu opened on", async () => {
    const { calls } = await ready();
    expect(await useBranchesStore().undoLastCommit({ expected: LATER })).toBe(false);
    expect(lastToast()?.key).toBe("branches.undoMoved");
    expect(moves(calls)).toHaveLength(0);
  });

  it("is busy while the confirmation plans, and a second press neither plans nor runs", async () => {
    const { calls } = await ready({ refs: [head(), ref({ ahead: 0 })] });
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(false);
    const first = branches.undoLastCommit({ confirmed: HASH });
    expect(branches.planningUndo).toBe(true);
    expect(await branches.undoLastCommit({ confirmed: HASH })).toBe(false);
    expect(await first).toBe(true);
    expect(branches.planningUndo).toBe(false);
    expect(moves(calls)).toHaveLength(1);
    expect(useToastsStore().toasts.map((toast) => toast.key)).toEqual(["branches.undone"]);
  });

  it("gives each toast's Redo its own undo, and a second undo the box the first one filled", async () => {
    const GRAND = "a".repeat(40);
    const { calls, options } = await ready();
    const branches = useBranchesStore();
    const changes = useChangesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    const first = lastToast();
    // The parent is the next commit to undo, with its own message.
    options.commitContext = { headParents: [GRAND], headMessage: "feat: the parent" };
    expect(await branches.undoLastCommit()).toBe(true);
    expect(changes.draft.subject).toBe("feat: the parent");
    expect(lastToast()?.key).toBe("branches.undone");
    // The first toast went with the second undo; its Redo, run anyway, redoes nothing.
    expect(useToastsStore().toasts.map((toast) => toast.id)).not.toContain(first?.id);
    first?.onAction?.();
    await settled();
    expect(moves(calls)).toHaveLength(2);
    expect(lastToast()?.key).toBe("branches.redoStale");
    expect(await branches.redoUndone()).toBe(true);
    expect(moves(calls)[2]).toMatchObject({ from: GRAND, to: PARENT });
  });

  it("reads again before Redo and refuses while a merge or conflicts hold HEAD", async () => {
    const { calls, options } = await ready();
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    options.commitContext = { headParents: [PARENT], operation: "merge" };
    expect(await branches.redoUndone()).toBe(false);
    expect(lastToast()?.key).toBe("branches.undoRefused.merging");
    options.commitContext = { headParents: [PARENT] };
    options.conflicts = conflicts;
    expect(await branches.redoUndone()).toBe(false);
    expect(lastToast()?.key).toBe("branches.undoRefused.conflicts");
    expect(moves(calls)).toHaveLength(1);
  });

  it("offers Redo while it can run, and not on another branch", async () => {
    const { options } = await ready();
    const branches = useBranchesStore();
    expect(branches.canRedo).toBe(false);
    expect(await branches.undoLastCommit()).toBe(true);
    await settled();
    expect(branches.canRedo).toBe(true);
    options.refs = [
      head(PARENT),
      ref({ target: PARENT, isCurrent: false }),
      ref({ name: "other", fullName: "refs/heads/other", target: PARENT, upstream: null }),
    ];
    await useRepoStore().refreshRefs();
    expect(branches.canRedo).toBe(false);
  });

  it("says why when the commit cannot be read, git's output one click away", async () => {
    const { calls } = await ready({
      commitContextError: {
        code: "git.cli_failed",
        message: "git log failed",
        detail: "fatal: bad object HEAD",
      },
    });
    expect(await useBranchesStore().undoLastCommit()).toBe(false);
    const toast = lastToast();
    expect(toast?.kind).toBe("error");
    expect(toast?.key).toBe("branches.undoRefused.unknown");
    expect(toast?.output).toBe("fatal: bad object HEAD");
    expect(moves(calls)).toHaveLength(0);
  });

  it("turns amend off for a message whose body follows the subject without a blank line", async () => {
    await ready({ commitContext: { headParents: [PARENT], headMessage: "fix: one\nthe body" } });
    const changes = useChangesStore();
    changes.setDraft({ amend: true });
    expect(await useBranchesStore().undoLastCommit()).toBe(true);
    expect(changes.draft.amend).toBe(false);
    expect(changes.draft.body).toBe("the body");
    expect(lastToast()?.key).toBe("branches.undone");
  });

  it("keeps the redo once its toast is gone", async () => {
    const { calls } = await ready();
    const branches = useBranchesStore();
    expect(await branches.undoLastCommit()).toBe(true);
    useToastsStore().clear();
    expect(await branches.redoUndone()).toBe(true);
    expect(moves(calls)[1]).toMatchObject({ from: PARENT, to: HASH });
  });
});
