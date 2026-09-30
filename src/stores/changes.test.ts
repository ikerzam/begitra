import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import type { DiffTarget, PatchSelection, Ref } from "@/ipc/schemas";
import {
  FAKE_COMMIT_HASH,
  fakeBackend,
  fakeCommit,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import * as ipc from "@/ipc/commands";
import { AppError } from "@/ipc/errors";
import { changedFile, repoChange } from "@/test/changes";

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
  changedFile("src/new.md", { status: "added", additions: 3, deletions: 0 }),
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
  // Made before the open, as the shell makes it: the lists load once the history shows.
  const changes = useChangesStore();
  await useRepoStore().open("/r");
  await settled();
  return { changes, calls };
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

/** The paths each list shows. */
function shown(changes: ReturnType<typeof useChangesStore>): {
  unstaged: string[];
  staged: string[];
} {
  return {
    unstaged: changes.unstaged.files.map((file) => file.path),
    staged: changes.staged.files.map((file) => file.path),
  };
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
    changes.select("unstaged", "src/a.ts");
    const done = await changes.stage(["src/a.ts"]);
    await settled();
    expect(done).toBe(true);
    const staged = of(calls, "stage_paths");
    expect(staged).toHaveLength(1);
    expect(staged[0]?.args).toMatchObject({ repo: "/r", paths: ["src/a.ts"] });
    expect(changes.unstaged.files.map((file) => file.path)).toEqual(["src/b.ts", "src/new.md"]);
    expect(changes.staged.files.map((file) => file.path)).toEqual(["src/a.ts", "src/c.ts"]);
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
      untracked: ["src/new.md"],
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

  it("moves a staged file before git answers and selects the row that took its place", async () => {
    const gate = writeGate();
    const { changes } = await openChanges({ writeGate: gate });
    changes.select("unstaged", "src/a.ts");
    const done = changes.stage(["src/a.ts"]);
    expect(shown(changes)).toEqual({
      unstaged: ["src/b.ts", "src/new.md"],
      staged: ["src/a.ts", "src/c.ts"],
    });
    expect(changes.selected).toEqual({ list: "unstaged", path: "src/b.ts" });
    expect(changes.busy).toBe("operations.staging");
    expect(useOperationsStore().current?.label).toBe("operations.staging");
    expect(changes.writing).toBe(true);
    expect(changes.blocking).toBe(false);
    expect(gate.waiting).toEqual(["stage_paths"]);
    gate.release();
    expect(await done).toBe(true);
    await settled();
    expect(changes.busy).toBeNull();
    expect(changes.writing).toBe(false);
    expect(shown(changes)).toEqual({
      unstaged: ["src/b.ts", "src/new.md"],
      staged: ["src/a.ts", "src/c.ts"],
    });
  });

  it("runs file writes one at a time in the order asked, each moving when asked", async () => {
    const gate = writeGate();
    const { changes, calls } = await openChanges({ writeGate: gate });
    const writes = [
      changes.stage(["src/a.ts"]),
      changes.stage(["src/b.ts"]),
      changes.unstage(["src/c.ts"]),
    ];
    expect(shown(changes)).toEqual({
      unstaged: ["src/c.ts", "src/new.md"],
      staged: ["src/a.ts", "src/b.ts"],
    });
    for (let i = 0; i < 3; i += 1) {
      await settled();
      expect(gate.waiting).toHaveLength(1);
      gate.release();
    }
    expect(await Promise.all(writes)).toEqual([true, true, true]);
    await settled();
    expect(of(calls, "stage_paths").map((call) => call.args["paths"])).toEqual([
      ["src/a.ts"],
      ["src/b.ts"],
    ]);
    expect(of(calls, "unstage_paths")).toHaveLength(1);
    const stagedAt = calls.findIndex((call) => call.cmd === "unstage_paths");
    expect(stagedAt).toBeGreaterThan(calls.map((call) => call.cmd).lastIndexOf("stage_paths"));
    expect(shown(changes)).toEqual({
      unstaged: ["src/c.ts", "src/new.md"],
      staged: ["src/a.ts", "src/b.ts"],
    });
  });

  it("shows git's lists again when a write is refused, and drops the writes asked after it", async () => {
    const gate = writeGate();
    const { changes, calls } = await openChanges({ writeGate: gate });
    const first = changes.stage(["src/a.ts"]);
    const second = changes.stage(["src/b.ts"]);
    expect(shown(changes).staged).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    gate.refuse();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    await settled();
    expect(shown(changes)).toEqual({
      unstaged: ["src/a.ts", "src/b.ts", "src/new.md"],
      staged: ["src/c.ts"],
    });
    expect(of(calls, "stage_paths")).toHaveLength(1);
    expect(changes.actionError?.detail).toContain("index.lock");
    expect(changes.failed).toEqual({ kind: "stage", files: 1, path: "src/a.ts" });
    expect(changes.writing).toBe(false);
  });

  it("keeps a move over a read that started before the write", async () => {
    const gate = writeGate();
    const { changes } = await openChanges({
      writeGate: gate,
      diffPathsDelayMs: { workingTree: 30, index: 30 },
    });
    // The watcher reads src/a.ts while it is unstaged; the reply lands after the stage.
    changes.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/a.ts"] }));
    await settled();
    const done = changes.stage(["src/a.ts"]);
    gate.release();
    expect(await done).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settled();
    expect(shown(changes).unstaged).not.toContain("src/a.ts");
    expect(shown(changes).staged).toContain("src/a.ts");
    // The reads asked after the stage land and show git's answer: the same.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await changes.settled();
    expect(shown(changes)).toEqual({
      unstaged: ["src/b.ts", "src/new.md"],
      staged: ["src/a.ts", "src/c.ts"],
    });
  });

  it("keeps the entry Staged lists already for a file staged again", async () => {
    const gate = writeGate();
    const { changes } = await openChanges({
      writeGate: gate,
      changes: {
        unstaged: [changedFile("src/a.ts", { additions: 7, deletions: 0 })],
        staged: [changedFile("src/a.ts", { additions: 2, deletions: 1 })],
      },
    });
    void changes.stage(["src/a.ts"]);
    expect(shown(changes)).toEqual({ unstaged: [], staged: ["src/a.ts"] });
    expect(changes.staged.files[0]?.additions).toBe(2);
    gate.release();
    await changes.settled();
  });

  it("takes an unstaged rename out of Staged and lists its sides once git answers", async () => {
    const gate = writeGate();
    const { changes } = await openChanges({
      writeGate: gate,
      changes: {
        unstaged: [],
        staged: [changedFile("src/new.ts", { status: "renamed", oldPath: "src/old.ts" })],
      },
    });
    void changes.unstage(["src/new.ts"]);
    expect(shown(changes)).toEqual({ unstaged: [], staged: [] });
    gate.release();
    await changes.settled();
    expect(shown(changes).unstaged).toContain("src/new.ts");
  });

  it("takes discarded files out of Unstaged before git answers", async () => {
    const gate = writeGate();
    const { changes } = await openChanges({ writeGate: gate });
    const files = changes.unstaged.files.filter((file) => file.path !== "src/b.ts");
    void changes.discard(files);
    expect(shown(changes)).toEqual({ unstaged: ["src/b.ts"], staged: ["src/c.ts"] });
    gate.release();
    await changes.settled();
    expect(shown(changes)).toEqual({ unstaged: ["src/b.ts"], staged: ["src/c.ts"] });
  });

  it("commits once the stage asked before it ran, keeping the lists inert meanwhile", async () => {
    const gate = writeGate();
    const { changes, calls } = await openChanges({ writeGate: gate });
    void changes.stage(["src/a.ts"]);
    changes.setDraft({ subject: "feat: a" });
    expect(changes.canCommit).toBe(true);
    const committing = changes.commit();
    expect(changes.blocking).toBe(true);
    expect(changes.canCommit).toBe(false);
    gate.release();
    await settled();
    // The commit runs now, the lists still inert.
    expect(gate.waiting).toEqual(["commit"]);
    expect(changes.blocking).toBe(true);
    gate.release();
    expect(await committing).toBe(true);
    await settled();
    const order = calls
      .filter((call) => call.cmd === "stage_paths" || call.cmd === "commit")
      .map((call) => call.cmd);
    expect(order).toEqual(["stage_paths", "commit"]);
    expect(changes.blocking).toBe(false);
    expect(changes.draft.subject).toBe("");
  });

  it("drops a commit asked behind a stage that git refuses", async () => {
    const gate = writeGate();
    const { changes, calls } = await openChanges({ writeGate: gate });
    void changes.stage(["src/a.ts"]);
    changes.setDraft({ subject: "feat: a" });
    const committing = changes.commit();
    gate.refuse();
    expect(await committing).toBe(false);
    await settled();
    expect(of(calls, "commit")).toHaveLength(0);
    expect(changes.draft.subject).toBe("feat: a");
    expect(changes.actionError?.detail).toContain("index.lock");
  });

  it("keeps the rows inert while a line action waits for the file writes before it", async () => {
    const gate = writeGate();
    const { changes } = await openChanges({ writeGate: gate });
    void changes.stage(["src/a.ts"]);
    const file = changes.unstaged.files.find((entry) => entry.path === "src/b.ts")!;
    const applying = changes.applySelection("stage", file, null);
    expect(changes.blocking).toBe(true);
    gate.release();
    await settled();
    expect(gate.waiting).toEqual(["apply_selection"]);
    expect(changes.blocking).toBe(true);
    gate.release();
    expect(await applying).toBe(true);
    expect(changes.blocking).toBe(false);
  });

  it("drops the writes waiting when another repository opens", async () => {
    const gate = writeGate();
    const { changes, calls } = await openChanges({ writeGate: gate });
    void changes.stage(["src/a.ts"]);
    const waiting = changes.stage(["src/b.ts"]);
    changes.reset();
    expect(await waiting).toBe(false);
    gate.release();
    await settled();
    expect(of(calls, "stage_paths")).toHaveLength(1);
    expect(shown(changes)).toEqual({ unstaged: [], staged: [] });
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

  it("reads again what the watcher names, whole when it cannot say, the context on refs", async () => {
    const { changes, calls } = await openChanges();
    const before = of(calls, "diff").length;
    changes.onRepoChanged(repoChange({ kinds: ["worktrees"] }));
    await settled();
    expect(of(calls, "diff")).toHaveLength(before);
    // A working tree path: the unstaged list at that path alone.
    changes.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/a.ts"] }));
    await settled();
    expect(of(calls, "diff")).toHaveLength(before);
    const restricted = of(calls, "diff_paths");
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.args["target"]).toEqual({ kind: "working-tree", base: "index" });
    expect(restricted[0]?.args["paths"]).toEqual(["src/a.ts"]);
    // Index entries: both lists at those paths; a stat refresh names none and reads nothing.
    changes.onRepoChanged(repoChange({ kinds: ["index"], indexPaths: ["src/c.ts"] }));
    changes.onRepoChanged(repoChange({ kinds: ["index"], indexPaths: [] }));
    await settled();
    expect(of(calls, "diff_paths")).toHaveLength(3);
    // Unknown paths and the ignore rules read everything.
    changes.onRepoChanged(repoChange({ kinds: ["status"] }));
    await settled();
    expect(of(calls, "diff")).toHaveLength(before + 1);
    changes.onRepoChanged(repoChange({ kinds: ["status"], paths: [".gitignore"] }));
    await settled();
    expect(of(calls, "diff")).toHaveLength(before + 2);
    changes.onRepoChanged(repoChange({ kinds: ["index"], indexPaths: null }));
    await settled();
    expect(of(calls, "diff")).toHaveLength(before + 4);
    changes.onRepoChanged(repoChange({ kinds: ["refs"] }));
    await settled();
    expect(of(calls, "commit_context")).toHaveLength(1);
  });

  it("hands the selection to the row that took the file's place when Staged answers first", async () => {
    const { changes } = await openChanges({
      changes: {
        unstaged: [changedFile("a.ts"), changedFile("b.ts"), changedFile("c.ts")],
        staged: [],
      },
      diffPathsDelayMs: { workingTree: 20 },
    });
    changes.select("unstaged", "b.ts");
    // The lists show the move when asked; the write resolves once git did it.
    expect(await changes.stage(["b.ts"])).toBe(true);
    expect(changes.unstaged.files.map((file) => file.path)).toEqual(["a.ts", "c.ts"]);
    expect(changes.staged.files.map((file) => file.path)).toEqual(["b.ts"]);
    expect(changes.selected).toEqual({ list: "unstaged", path: "c.ts" });
  });

  it("drops a restricted reply that a whole reload overtook", async () => {
    const { changes } = await openChanges({ diffPathsDelayMs: { workingTree: 20 } });
    // A read of src/a.ts starts while the file is unstaged; it is staged elsewhere and the
    // lists reload whole before the reply, which still lists it unstaged, lands.
    changes.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/a.ts"] }));
    await settled();
    await ipc.stagePaths("/r", ["src/a.ts"]);
    changes.load();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settled();
    expect(changes.unstaged.files.map((file) => file.path)).not.toContain("src/a.ts");
    expect(changes.staged.files.map((file) => file.path)).toContain("src/a.ts");
  });

  it("reads again the paths a write moved, and they list as a whole reload lists them", async () => {
    const { changes, calls } = await openChanges();
    const whole = of(calls, "diff").length;
    expect(await changes.stage(["src/a.ts"])).toBe(true);
    await settled();
    // No whole reload: both lists at the staged path.
    expect(of(calls, "diff")).toHaveLength(whole);
    expect(of(calls, "diff_paths").map((call) => call.args["paths"])).toEqual([
      ["src/a.ts"],
      ["src/a.ts"],
    ]);
    const restricted = {
      unstaged: changes.unstaged.files.map((file) => file.path),
      staged: changes.staged.files.map((file) => file.path),
    };
    changes.load();
    await settled();
    expect(restricted).toEqual({
      unstaged: changes.unstaged.files.map((file) => file.path),
      staged: changes.staged.files.map((file) => file.path),
    });
    expect(restricted.staged).toContain("src/a.ts");
  });

  it("streams the staged list again when HEAD moves, not when another branch does", async () => {
    const branch = (name: string, commit: number): Ref => ({
      name,
      fullName: name === "HEAD" ? "HEAD" : `refs/heads/${name}`,
      kind: name === "HEAD" ? "head" : "local-branch",
      target: fakeCommit(commit).hash,
      isCurrent: name !== "agent",
      upstream: null,
      ahead: null,
      behind: null,
      worktree: name === "agent" ? "/r-agent" : null,
      message: null,
      committedAt: null,
    });
    const refs = [branch("agent", 3), branch("main", 0), branch("HEAD", 0)];
    const { changes, calls } = await openChanges({ refs });
    const repo = useRepoStore();
    const lists = () => of(calls, "diff").map((call) => (call.args["target"] as DiffTarget).kind);
    const before = lists().length;
    // A commit in a linked worktree moves its branch, not HEAD: the lists stay.
    refs[0] = branch("agent", 4);
    await repo.refreshRefs();
    await settled();
    expect(lists()).toHaveLength(before);
    // A soft reset in a terminal moves HEAD and leaves the index: the staged list follows.
    refs[1] = branch("main", 1);
    refs[2] = branch("HEAD", 1);
    await repo.refreshRefs();
    await settled();
    expect(lists().slice(before)).toEqual(["index"]);
    expect(changes.staged.loading).toBe(false);
    expect(changes.unstaged.files.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/new.md",
    ]);
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

describe("the lists before the screen", () => {
  const lists = {
    unstaged: [changedFile("a.ts"), changedFile("b.ts")],
    staged: [changedFile("b.ts"), changedFile("c.ts")],
  };

  it("load once the repository shows its first page of history, a file in both lists counted once", async () => {
    const calls = fakeBackend({ changes: lists });
    const changes = useChangesStore();
    await useRepoStore().open("/r");
    await settled();
    expect(changes.loaded).toBe(true);
    expect(changes.counts).toEqual({ unstaged: 2, staged: 2, changed: 3 });
    // After the open's own work: the first page of history streams first.
    const order = calls.map((call) => call.cmd);
    expect(order.indexOf("diff")).toBeGreaterThan(order.indexOf("walk_commits"));
  });

  it("are emptied at once by another open, the draft kept only for the same repository", async () => {
    fakeBackend({ changes: lists, rootIsPath: true });
    const changes = useChangesStore();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    changes.setDraft({ subject: "draft" });
    const again = repo.open("/r");
    await nextTick();
    expect(changes.counts).toBeNull();
    await again;
    await settled();
    expect(changes.draft.subject).toBe("draft");
    expect(changes.counts?.changed).toBe(3);
    const other = repo.open("/other");
    await nextTick();
    expect(changes.counts).toBeNull();
    await other;
    await settled();
    expect(changes.draft.subject).toBe("");
    expect(changes.counts?.changed).toBe(3);
  });

  it("count only when neither list streams, keeping the last counts through a reload", async () => {
    fakeBackend({ changes: lists });
    const changes = useChangesStore();
    await useRepoStore().open("/r");
    await settled();
    expect(changes.counts).toEqual({ unstaged: 2, staged: 2, changed: 3 });
    // A full reload streams its first page: the counts are the last ones until it ends.
    changes.unstaged = { ...changes.unstaged, loading: true, files: [changedFile("a.ts")] };
    await nextTick();
    expect(changes.counts).toEqual({ unstaged: 2, staged: 2, changed: 3 });
    changes.unstaged = { ...changes.unstaged, loading: false };
    await nextTick();
    expect(changes.counts).toEqual({ unstaged: 1, staged: 2, changed: 3 });
    // A failed list leaves the counts unknown.
    changes.staged = { ...changes.staged, error: new AppError("git.cli_failed", "x") };
    await nextTick();
    expect(changes.counts).toBeNull();
  });

  it("stream nothing again when the screen opens on lists already loaded", async () => {
    const calls = fakeBackend({ changes: lists });
    const changes = useChangesStore();
    await useRepoStore().open("/r");
    await settled();
    const diffs = of(calls, "diff").length;
    changes.ensureLoaded();
    await settled();
    expect(of(calls, "diff")).toHaveLength(diffs);
    // A load that did not happen, or failed, is done on the screen's entry.
    changes.load();
    await settled();
    expect(of(calls, "diff")).toHaveLength(diffs + 2);
  });
});
