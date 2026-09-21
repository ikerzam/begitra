import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PatchSelection } from "@/ipc/schemas";
import {
  FAKE_COMMIT_HASH,
  fakeBackend,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { changedFile } from "@/test/changes";

import {
  lineKey,
  messageOf,
  selectionOf,
  templateBody,
  useChangesStore,
  wholeSelection,
} from "./changes";
import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";

const unstagedFiles = () => [
  changedFile("src/a.ts"),
  changedFile("src/b.ts"),
  changedFile("docs/new.md", { status: "added", additions: 3, deletions: 0 }),
];
const stagedFiles = () => [changedFile("src/c.ts")];

async function openChanges(options: FakeBackendOptions = {}): Promise<{
  changes: ReturnType<typeof useChangesStore>;
  calls: Call[];
}> {
  const calls = fakeBackend({
    changes: { unstaged: unstagedFiles(), staged: stagedFiles() },
    ...options,
  });
  await useRepoStore().open("/r");
  await settled();
  const changes = useChangesStore();
  changes.load();
  await settled();
  return { changes, calls };
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

describe("changes helpers", () => {
  it("builds a selection with the chosen changed lines flagged and the rest not", () => {
    const file = changedFile("src/a.ts");
    const chosen = selectionOf(file, new Set([lineKey(0, 2)]));
    expect(chosen.path).toBe("src/a.ts");
    expect(chosen.status).toBe("modified");
    expect(chosen.lossy).toBe(false);
    expect(chosen.hunks[0]?.lines.map((l) => l.selected)).toEqual([false, false, true, false]);
    // Context lines are never selected, whatever the set says.
    const context = selectionOf(file, new Set([lineKey(0, 0)]));
    expect(context.hunks[0]?.lines[0]?.selected).toBe(false);
    const whole = wholeSelection(file);
    expect(whole.hunks[0]?.lines.map((l) => l.selected)).toEqual([false, true, true, true]);
  });

  it("joins the subject and the body with a blank line, trimming both", () => {
    expect(messageOf({ subject: " feat: x ", body: "" })).toBe("feat: x");
    expect(messageOf({ subject: "feat: x", body: "\nbody\n\n" })).toBe("feat: x\n\nbody");
  });

  it("drops the comment lines of a template", () => {
    expect(templateBody("# type(scope): subject\n\nfeat(): \n# body\n")).toBe("feat():");
    expect(templateBody("# only comments\n")).toBe("");
  });
});

describe("changes store", () => {
  it("streams both lists without ignoring whitespace and selects the first unstaged file", async () => {
    const { changes, calls } = await openChanges();
    // The graph's diff of the selected commit comes first; the two lists follow.
    const diffs = of(calls, "diff").filter(
      (call) => (call.args["target"] as { kind: string }).kind !== "commit",
    );
    expect(diffs.map((call) => call.args["target"])).toEqual([
      { kind: "working-tree", base: "index" },
      { kind: "index" },
    ]);
    for (const call of diffs) {
      expect((call.args["options"] as { ignoreWhitespace: boolean }).ignoreWhitespace).toBe(false);
    }
    expect(changes.unstagedCount).toBe(3);
    expect(changes.stagedCount).toBe(1);
    expect(changes.loading).toBe(false);
    expect(changes.isEmpty).toBe(false);
    expect(changes.selected).toEqual({ list: "unstaged", path: "src/a.ts" });
    expect(changes.selectedFile?.path).toBe("src/a.ts");
    expect(useOperationsStore().current).toBeUndefined();
  });

  it("is empty on a clean tree and reports a failed diff", async () => {
    const { changes } = await openChanges({ changes: { unstaged: [], staged: [] } });
    expect(changes.isEmpty).toBe(true);
    expect(changes.selected).toBeNull();
    expect(changes.canCommit).toBe(false);
    clearMocks();
    setActivePinia(createPinia());
    await useSettingsStore().init(memoryStorage(), "windows");
    const failed = await openChanges({ failDiff: true });
    expect(failed.changes.error?.code).toBe("diff.blob_missing");
    expect(failed.changes.isEmpty).toBe(false);
  });

  it("stages a file, reloads and hands the selection to the row that took its place", async () => {
    const { changes, calls } = await openChanges();
    const done = await changes.stage(["src/a.ts"]);
    await settled();
    expect(done).toBe(true);
    const staged = of(calls, "stage_paths");
    expect(staged).toHaveLength(1);
    expect(staged[0]?.args).toMatchObject({ repo: "/r", paths: ["src/a.ts"] });
    expect(changes.unstaged.files.map((file) => file.path)).toEqual(["src/b.ts", "docs/new.md"]);
    expect(changes.staged.files.map((file) => file.path)).toEqual(["src/c.ts", "src/a.ts"]);
    expect(changes.selected).toEqual({ list: "unstaged", path: "src/b.ts" });
    expect(changes.busy).toBeNull();
    expect(changes.actionError).toBeNull();
  });

  it("keeps the selection on a file that stayed, and moves to the other list when its own emptied", async () => {
    const { changes } = await openChanges();
    changes.select("staged", "src/c.ts");
    await changes.stage(["src/b.ts"]);
    await settled();
    expect(changes.selected).toEqual({ list: "staged", path: "src/c.ts" });
    await changes.unstageAll();
    await settled();
    expect(changes.staged.files).toHaveLength(0);
    expect(changes.selected?.list).toBe("unstaged");
  });

  it("splits a discard into tracked and untracked paths", async () => {
    const { changes, calls } = await openChanges();
    await changes.discard(changes.unstaged.files);
    await settled();
    const discarded = of(calls, "discard_paths");
    expect(discarded[0]?.args).toMatchObject({
      tracked: ["src/a.ts", "src/b.ts"],
      untracked: ["docs/new.md"],
    });
    expect(changes.unstaged.files).toHaveLength(0);
    expect(changes.selected).toEqual({ list: "staged", path: "src/c.ts" });
  });

  it("applies the selected lines and, without a set, the whole file", async () => {
    const { changes, calls } = await openChanges();
    const file = changes.unstaged.files[0]!;
    await changes.applySelection("stage", file, new Set([lineKey(0, 1), lineKey(0, 2)]));
    await settled();
    const applied = of(calls, "apply_selection");
    expect(applied[0]?.args["target"]).toBe("stage");
    const selection = applied[0]?.args["selection"] as PatchSelection;
    expect(selection.hunks[0]?.lines.map((l) => l.selected)).toEqual([false, true, true, false]);
    // Part of the file crossed: it is in both lists and stays selected.
    expect(changes.staged.files.map((f) => f.path)).toContain("src/a.ts");
    expect(changes.selected).toEqual({ list: "unstaged", path: "src/a.ts" });
    await changes.applySelection("unstage", changes.staged.files[0]!, null);
    await settled();
    const whole = of(calls, "apply_selection")[1]?.args["selection"] as PatchSelection;
    expect(whole.hunks[0]?.lines.map((l) => l.selected)).toEqual([false, true, true, true]);
  });

  it("keeps the lists and shows git's output when a write fails", async () => {
    const { changes } = await openChanges({ failStaging: true });
    const done = await changes.stage(["src/a.ts"]);
    await settled();
    expect(done).toBe(false);
    expect(changes.actionError?.code).toBe("git.cli_failed");
    expect(changes.actionError?.detail).toContain("patch does not apply");
    expect(changes.unstaged.files).toHaveLength(3);
    expect(changes.busy).toBeNull();
    changes.dismissError();
    expect(changes.actionError).toBeNull();
  });

  it("refuses a second write while one runs", async () => {
    const { changes, calls } = await openChanges();
    const first = changes.stage(["src/a.ts"]);
    expect(changes.busy).toBe("operations.staging");
    expect(useOperationsStore().current?.label).toBe("operations.staging");
    const second = await changes.stage(["src/b.ts"]);
    expect(second).toBe(false);
    await first;
    await settled();
    expect(of(calls, "stage_paths")).toHaveLength(1);
  });

  it("commits with the draft, clears the box, restarts the walk on the new commit", async () => {
    const { changes, calls } = await openChanges();
    expect(changes.canCommit).toBe(false);
    changes.setDraft({ subject: "feat: thing", body: "why\n" });
    expect(changes.canCommit).toBe(true);
    const done = await changes.commit();
    await settled();
    expect(done).toBe(true);
    const committed = of(calls, "commit");
    expect(committed[0]?.args["request"]).toEqual({
      message: "feat: thing\n\nwhy",
      amend: false,
      signoff: false,
    });
    expect(changes.lastCommit).toBe(FAKE_COMMIT_HASH);
    expect(changes.draft).toEqual({ subject: "", body: "", amend: false, signoff: false });
    expect(changes.staged.files).toHaveLength(0);
    // The graph listed the history again: two walks, and the context reloaded.
    expect(of(calls, "walk_commits").length).toBeGreaterThanOrEqual(2);
    expect(of(calls, "commit_context")).toHaveLength(1);
  });

  it("keeps the message and shows the hook's output when the commit fails", async () => {
    const { changes } = await openChanges({ failCommit: true });
    changes.setDraft({ subject: "wrong" });
    const done = await changes.commit();
    await settled();
    expect(done).toBe(false);
    expect(changes.draft.subject).toBe("wrong");
    expect(changes.actionError?.detail).toContain("commit-msg hook");
    expect(changes.lastCommit).toBeNull();
  });

  it("prefills the template body once and lets amend borrow HEAD's message", async () => {
    const { changes } = await openChanges({
      commitContext: { template: "# type: subject\n\nfeat(scope): \n", headMessage: "old\n\nbody" },
    });
    await changes.loadContext();
    expect(changes.context?.author).toBe("Iker Z. <iker@x>");
    expect(changes.draft.subject).toBe("feat(scope):");
    changes.setMessage("");
    expect(changes.draft.subject).toBe("");
    changes.setDraft({ amend: true });
    expect(changes.draft).toMatchObject({ subject: "old", body: "body", amend: true });
    // Untouched, the borrowed message leaves with amend.
    changes.setDraft({ amend: false });
    expect(changes.draft).toMatchObject({ subject: "", body: "", amend: false });
    // Edited, it stays.
    changes.setDraft({ amend: true });
    changes.setDraft({ subject: "old, edited" });
    changes.setDraft({ amend: false });
    expect(changes.draft.subject).toBe("old, edited");
  });

  it("prefers a prepared message (a merge in progress) over the template", async () => {
    const { changes } = await openChanges({
      commitContext: {
        template: "feat: ",
        operation: "merge",
        preparedMessage: "Merge branch 'other'\n\n# Conflicts:\n#\tREADME.md",
      },
    });
    await changes.loadContext();
    expect(changes.draft.subject).toBe("Merge branch 'other'");
    expect(changes.draft.body).toBe("# Conflicts:\n#\tREADME.md");
    expect(changes.context?.operation).toBe("merge");
  });

  it("cannot amend on an unborn branch, and needs staged files or amend", async () => {
    const { changes } = await openChanges({
      changes: { unstaged: unstagedFiles(), staged: [] },
      commitContext: { unborn: true, headMessage: null },
    });
    await changes.loadContext();
    changes.setDraft({ subject: "first" });
    expect(changes.canCommit).toBe(false);
    changes.setDraft({ amend: true });
    expect(changes.canCommit).toBe(false);
  });

  it("reloads on status and index changes when loaded and idle, the context on refs", async () => {
    const { changes, calls } = await openChanges();
    const before = of(calls, "diff").length;
    changes.onRepoChanged(["worktrees"]);
    await settled();
    expect(of(calls, "diff")).toHaveLength(before);
    changes.onRepoChanged(["status"]);
    await settled();
    expect(of(calls, "diff")).toHaveLength(before + 2);
    changes.onRepoChanged(["refs"]);
    await settled();
    expect(of(calls, "commit_context")).toHaveLength(1);
  });

  it("clears everything when the repository closes and starts afresh on another", async () => {
    const { changes } = await openChanges();
    changes.setDraft({ subject: "draft" });
    await useRepoStore().close();
    changes.load();
    expect(changes.loaded).toBe(false);
    expect(changes.unstaged.files).toHaveLength(0);
    expect(changes.selected).toBeNull();
    // The draft survives a reload of the same repository but not another one.
    expect(changes.draft.subject).toBe("draft");
  });
});
