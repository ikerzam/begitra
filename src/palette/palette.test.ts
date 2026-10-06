import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { paletteCommands, type PaletteActions } from "./commands";
import { matchesQuery, repoRowId, usePalette, type PaletteRepo } from "./usePalette";

const labels: Record<string, string> = {
  "palette.commandsById.open-folder": "Open folder…",
  "palette.commandsById.graph-focus": "Switch to graph focus",
  "palette.commandsById.review-focus": "Switch to review focus",
  "palette.commandsById.changes-focus": "Show changes",
  "palette.commandsById.checkout": "Checkout…",
  "palette.commandsById.create-branch": "Create branch…",
  "palette.commandsById.merge-into": "Merge into current branch…",
  "palette.commandsById.rebase-onto": "Rebase current branch onto…",
  "palette.commandsById.push": "Push…",
  "palette.commandsById.pull": "Pull…",
  "palette.commandsById.fetch-all": "Fetch all remotes",
  "palette.commandsById.remotes": "Remotes…",
  "palette.commandsById.stashes": "Stashes…",
  "palette.commandsById.stash-changes": "Stash changes…",
  "palette.commandsById.toggle-sidebar": "Toggle sidebar",
  "palette.commandsById.open-terminal": "Open in terminal",
  "palette.commandsById.open-editor": "Open in editor",
  "palette.commandsById.pin-project": "Pin project",
  "palette.commandsById.unpin-project": "Unpin project",
  "palette.commandsById.go-to-projects": "Go to projects",
  "palette.commandsById.scan-folders": "Scan folders",
  "palette.commandsById.add-folder": "Add folder…",
  "palette.commandsById.diff-from": "Diff from…",
  "palette.commandsById.review-worktree": "Review working tree changes",
  "palette.commandsById.review-index": "Review staged changes",
  "palette.commandsById.review-selected-commit": "Review selected commit",
  "palette.commandsById.toggle-layout": "Toggle side by side",
  "palette.commandsById.toggle-wrap": "Toggle word wrap",
  "palette.commandsById.toggle-whitespace": "Ignore whitespace",
  "palette.commandsById.next-symbol": "Next changed symbol",
  "palette.commandsById.previous-symbol": "Previous changed symbol",
  "palette.commandsById.next-hunk": "Next hunk",
  "palette.commandsById.previous-hunk": "Previous hunk",
  "palette.commandsById.next-file": "Next file",
  "palette.commandsById.previous-file": "Previous file",
  "palette.commandsById.mark-reviewed": "Mark file reviewed",
  "palette.commandsById.toggle-overview": "Show or hide the change overview",
  "palette.commandsById.toggle-hide-generated": "Show or hide generated files",
  "palette.commandsById.toggle-hide-lockfiles": "Show or hide lockfiles",
  "palette.commandsById.toggle-hide-tests": "Show or hide test files",
  "palette.commandsById.compare-with": "Compare with…",
  "palette.commandsById.swap-comparison": "Swap comparison sides",
  "palette.commandsById.compare-open-review": "Open comparison in review",
  "palette.commandsById.settings": "Settings…",
  "palette.commandsById.show-worktrees": "Show worktrees",
  "palette.commandsById.add-worktree": "Add worktree…",
  "palette.commandsById.prune-worktrees": "Prune worktrees",
  "palette.commandsById.locale-en": "Language: English",
  "palette.commandsById.locale-es": "Language: Spanish",
};

interface ActionOptions {
  hasRepository?: boolean;
  /** Whether the open project is pinned; null without an open project. */
  pinned?: boolean | null;
  hasFolderProjects?: boolean;
  hasReviewNotes?: boolean;
  /** The open project holds more than one repository. */
  several?: boolean;
  /** The last undo of a commit can be redone. */
  canRedo?: boolean;
}

function actions(options: ActionOptions | boolean = {}): PaletteActions & { calls: string[] } {
  const {
    hasRepository = true,
    pinned = false,
    hasFolderProjects = true,
    hasReviewNotes = false,
    several = false,
    canRedo = false,
  } = typeof options === "boolean" ? { hasRepository: options } : options;
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    hasRepository: () => hasRepository,
    projectPinned: () => pinned,
    hasFolderProjects: () => hasFolderProjects,
    openFolder: () => {
      calls.push("openFolder");
      return Promise.resolve();
    },
    goToProjects: () => {
      calls.push("goToProjects");
      return Promise.resolve();
    },
    scanFolders: record("scan"),
    addFolder: () => {
      calls.push("addFolder");
      return Promise.resolve();
    },
    pinProject: (pinned) => {
      calls.push(`pin:${pinned}`);
      return Promise.resolve();
    },
    setGraphFocus: record("graph"),
    setReviewFocus: record("review"),
    toggleSidebar: record("sidebar"),
    openTerminal: () => {
      calls.push("terminal");
      return Promise.resolve();
    },
    openEditor: () => {
      calls.push("editor");
      return Promise.resolve();
    },
    setLocale: (locale) => {
      calls.push(`locale:${locale}`);
      return Promise.resolve();
    },
    diffFrom: record("diffFrom"),
    reviewWorktree: () => {
      calls.push("reviewWorktree");
      return Promise.resolve();
    },
    reviewIndex: () => {
      calls.push("reviewIndex");
      return Promise.resolve();
    },
    reviewSelectedCommit: () => {
      calls.push("reviewSelectedCommit");
      return Promise.resolve();
    },
    hasSelectedCommit: () => hasRepository,
    copyReviewNotes: () => {
      calls.push("copyReviewNotes");
      return Promise.resolve();
    },
    hasReviewNotes: () => hasReviewNotes,
    inReview: () => false,
    toggleLayout: () => {
      calls.push("toggleLayout");
      return Promise.resolve();
    },
    toggleWrap: () => {
      calls.push("toggleWrap");
      return Promise.resolve();
    },
    toggleWhitespace: () => {
      calls.push("toggleWhitespace");
      return Promise.resolve();
    },
    toggleWholeFile: () => {
      calls.push("toggleWholeFile");
      return Promise.resolve();
    },
    runShortcut: (id) => {
      calls.push(`shortcut:${id}`);
    },
    shortcutActive: () => false,
    toggleOverview: () => {
      calls.push("toggleOverview");
    },
    toggleFilter: (key) => {
      calls.push(`filter:${key}`);
    },
    compareWith: () => {
      calls.push("compareWith");
    },
    inComparison: () => false,
    showChanges: () => {
      calls.push("showChanges");
      return Promise.resolve();
    },
    inChanges: () => false,
    changesAll: (action) => {
      calls.push(`changesAll:${action}`);
    },
    branchAction: (action) => {
      calls.push(`branch:${action}`);
    },
    network: (action) => {
      calls.push(`network:${action}`);
    },
    undoLastCommit: () => {
      calls.push("undoLastCommit");
    },
    canRedoUndone: () => canRedo,
    redoUndoneCommit: () => {
      calls.push("redoUndoneCommit");
    },
    fetchAll: () => {
      calls.push("fetchAll");
      return Promise.resolve();
    },
    openRemotes: () => {
      calls.push("remotes");
      return Promise.resolve();
    },
    openStashes: () => {
      calls.push("stashes");
    },
    inOperation: () => false,
    sequencer: (action) => {
      calls.push(`sequencer:${action}`);
    },
    swapComparison: () => {
      calls.push("swapComparison");
      return Promise.resolve();
    },
    openComparisonInReview: () => {
      calls.push("openComparisonInReview");
      return Promise.resolve();
    },
    showWorktrees: () => {
      calls.push("showWorktrees");
      return Promise.resolve();
    },
    openSettings: () => {
      calls.push("openSettings");
      return Promise.resolve();
    },
    addWorktree: record("addWorktree"),
    hasPrunableWorktrees: () => false,
    pruneWorktrees: record("pruneWorktrees"),
    hasActiveProject: () => pinned !== null,
    hasSeveralRepositories: () => several,
    newProject: record("newProject"),
    editProject: record("editProject"),
    showOverview: () => {
      calls.push("showOverview");
      return Promise.resolve();
    },
    fetchProject: () => {
      calls.push("fetchProject");
      return Promise.resolve();
    },
    projectNeighbour: (step) => {
      calls.push(`projectNeighbour:${step}`);
      return Promise.resolve();
    },
  };
}

function key(k: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, cancelable: true });
}

describe("matchesQuery", () => {
  it("matches words in order, ignoring case", () => {
    expect(matchesQuery("Switch to review focus", "rev")).toBe(true);
    expect(matchesQuery("Switch to review focus", "sw foc")).toBe(true);
    expect(matchesQuery("Switch to review focus", "foc sw")).toBe(false);
    expect(matchesQuery("Switch to review focus", "")).toBe(true);
    expect(matchesQuery("Open folder…", "FOLD")).toBe(true);
  });
});

describe("usePalette", () => {
  function setup(options: ActionOptions | boolean = {}, repos?: PaletteRepo[]) {
    const acts = actions(options);
    const onClose = vi.fn();
    const palette = usePalette({
      commands: computed(() => paletteCommands(acts)),
      translate: (k) => labels[k] ?? k,
      onClose,
      repos: repos ? ref(repos) : undefined,
    });
    return { acts, onClose, palette };
  }

  it("lists every enabled command and filters by the query", () => {
    const { palette } = setup();
    expect(palette.rows.value.map((r) => r.command.id)).toEqual([
      "open-folder",
      "graph-focus",
      "review-focus",
      "changes-focus",
      "toggle-sidebar",
      "zoom-in",
      "zoom-out",
      "zoom-reset",
      "open-terminal",
      "open-editor",
      "pin-project",
      "go-to-projects",
      "scan-folders",
      "add-folder",
      "diff-from",
      "review-worktree",
      "review-index",
      "review-selected-commit",
      "toggle-layout",
      "toggle-wrap",
      "toggle-whitespace",
      "toggle-whole-file",
      "compare-with",
      "settings",
      "show-worktrees",
      "add-worktree",
      "new-project",
      "edit-project",
      "checkout",
      "create-branch",
      "merge-into",
      "rebase-onto",
      "undo-last-commit",
      "push",
      "pull",
      "fetch-all",
      "remotes",
      "stashes",
      "stash-changes",
      "toggle-hide-generated",
      "toggle-hide-lockfiles",
      "toggle-hide-tests",
      "locale-en",
      "locale-es",
    ]);
    palette.query.value = "rev focus";
    expect(palette.rows.value.map((r) => r.label)).toEqual(["Switch to review focus"]);
    expect(palette.isEmpty.value).toBe(false);
  });

  it("offers the commands of a project of several repositories, and runs them", async () => {
    const one = setup({}).palette.rows.value.map((r) => r.command.id);
    for (const id of ["show-project-overview", "fetch-project", "next-project-repo"]) {
      expect(one, id).not.toContain(id);
    }
    const { palette, acts } = setup({ several: true });
    const ids = palette.rows.value.map((r) => r.command.id);
    for (const id of [
      "new-project",
      "edit-project",
      "show-project-overview",
      "fetch-project",
      "next-project-repo",
      "previous-project-repo",
    ]) {
      expect(ids, id).toContain(id);
    }
    const overview = palette.rows.value.find((r) => r.command.id === "show-project-overview");
    expect(overview?.command.shortcutId).toBe("overview-focus");
    const next = palette.rows.value.find((r) => r.command.id === "next-project-repo");
    expect(next?.command.shortcutId).toBe("next-project-repo");
    await palette.rows.value.find((r) => r.command.id === "fetch-project")?.command.run();
    await next?.command.run();
    await overview?.command.run();
    expect(acts.calls).toEqual(["fetchProject", "projectNeighbour:1", "showOverview"]);
  });

  it("offers Redo undone commit only while an undo can be redone, and runs it", async () => {
    expect(setup().palette.rows.value.map((r) => r.command.id)).not.toContain("redo-undone-commit");
    const { palette, acts } = setup({ canRedo: true });
    const ids = palette.rows.value.map((r) => r.command.id);
    expect(ids.indexOf("redo-undone-commit")).toBe(ids.indexOf("undo-last-commit") + 1);
    await palette.rows.value.find((r) => r.command.id === "redo-undone-commit")?.command.run();
    expect(acts.calls).toEqual(["redoUndoneCommit"]);
  });

  it("offers to copy the review notes only when the target has some, and runs it", async () => {
    expect(setup().palette.rows.value.map((r) => r.command.id)).not.toContain("copy-review-notes");
    const { palette, acts } = setup({ hasReviewNotes: true });
    const row = palette.rows.value.find((r) => r.command.id === "copy-review-notes");
    expect(row).toBeDefined();
    await row!.command.run();
    expect(acts.calls).toContain("copyReviewNotes");
  });

  it("hides repository commands without a repository, and Scan folders without folder projects", () => {
    const { palette } = setup({ hasRepository: false, hasFolderProjects: false, pinned: null });
    const ids = palette.rows.value.map((r) => r.command.id);
    expect(ids).not.toContain("open-terminal");
    expect(ids).not.toContain("go-to-projects");
    expect(ids).not.toContain("pin-project");
    expect(ids).not.toContain("scan-folders");
    expect(ids).not.toContain("changes-focus");
    expect(ids).toContain("open-folder");
    expect(ids).toContain("add-folder");
  });

  it("offers Unpin for a pinned project, neither without one, and runs the discovery commands", async () => {
    const pinned = setup({ pinned: true });
    let ids = pinned.palette.rows.value.map((r) => r.command.id);
    expect(ids).toContain("unpin-project");
    expect(ids).not.toContain("pin-project");
    const find = (id: string) => {
      const row = pinned.palette.rows.value.find((r) => r.command.id === id);
      if (!row) throw new Error(`missing ${id}`);
      return row;
    };
    await pinned.palette.run(find("unpin-project"));
    await pinned.palette.run(find("scan-folders"));
    await find("add-folder").command.run();
    await find("go-to-projects").command.run();
    await find("changes-focus").command.run();
    expect(pinned.acts.calls).toEqual([
      "pin:false",
      "scan",
      "addFolder",
      "goToProjects",
      "showChanges",
    ]);
    // The staging commands wait for the changes screen.
    expect(ids).not.toContain("stage-all");
    expect(ids).not.toContain("commit");

    const outside = setup({ pinned: null });
    ids = outside.palette.rows.value.map((r) => r.command.id);
    expect(ids).not.toContain("pin-project");
    expect(ids).not.toContain("unpin-project");
  });

  it("lists the featured repositories with an empty query, every match with one, never under Recent", async () => {
    const opened: string[] = [];
    const repo = (name: string, featured: boolean): PaletteRepo => ({
      path: `/code/${name}`,
      name,
      context: `~/code/${name}`,
      featured,
      run: () => {
        opened.push(name);
      },
    });
    const { palette, onClose } = setup({}, [
      repo("geoportal", true),
      repo("begitra", false),
      repo("geoportal-infra", false),
    ]);
    const repoRows = () => palette.rows.value.filter((r) => r.section === "repos");
    expect(repoRows().map((r) => r.label)).toEqual(["geoportal"]);
    expect(repoRows()[0]?.context).toBe("~/code/geoportal");
    expect(repoRows()[0]?.command.id).toBe(repoRowId("/code/geoportal"));
    palette.query.value = "geo";
    expect(repoRows().map((r) => r.label)).toEqual(["geoportal", "geoportal-infra"]);
    palette.query.value = "code/beg";
    expect(repoRows().map((r) => r.label)).toEqual(["begitra"]);
    expect(palette.rows.value.every((r) => r.section === "repos")).toBe(true);
    palette.onKeydown(key("Enter"));
    await Promise.resolve();
    expect(opened).toEqual(["begitra"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(palette.recents.value).toEqual([]);
    expect(palette.rows.value.filter((r) => r.section === "recent")).toEqual([]);
  });

  it("runs the row under the cursor with enter, closes, and lists it under Recent", async () => {
    const { acts, onClose, palette } = setup();
    palette.query.value = "rev";
    expect(palette.onKeydown(key("Enter"))).toBe(true);
    await Promise.resolve();
    expect(acts.calls).toEqual(["review"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(palette.query.value).toBe("");
    expect(palette.rows.value[0]).toMatchObject({
      section: "recent",
      label: "Switch to review focus",
    });
    expect(palette.rows.value.filter((r) => r.section === "recent")).toHaveLength(1);
    expect(palette.rows.value.filter((r) => r.command.id === "review-focus")).toHaveLength(1);
  });

  it("keeps the last three run commands first, most recent first", async () => {
    const { palette } = setup();
    for (const id of ["graph-focus", "toggle-sidebar", "open-editor", "locale-es"]) {
      const row = palette.rows.value.find((r) => r.command.id === id);
      if (!row) throw new Error(`missing ${id}`);
      await palette.run(row);
    }
    const recent = palette.rows.value
      .filter((r) => r.section === "recent")
      .map((r) => r.command.id);
    expect(recent).toEqual(["locale-es", "open-editor", "toggle-sidebar"]);
    palette.query.value = "sw";
    expect(palette.rows.value.every((r) => r.section === "commands")).toBe(true);
  });

  it("moves the cursor with the arrows within bounds and closes with escape", () => {
    const { onClose, palette } = setup();
    palette.onKeydown(key("ArrowUp"));
    expect(palette.cursor.value).toBe(0);
    palette.onKeydown(key("ArrowDown"));
    palette.onKeydown(key("ArrowDown"));
    expect(palette.cursor.value).toBe(2);
    palette.query.value = "sw";
    palette.onKeydown(key("ArrowDown"));
    expect(palette.cursor.value).toBe(1);
    expect(palette.onKeydown(key("x"))).toBe(false);
    palette.onKeydown(key("Escape"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(palette.query.value).toBe("");
  });

  it("puts the cursor back on the first row when the query changes", async () => {
    const { acts, palette } = setup();
    for (let i = 0; i < 4; i += 1) palette.onKeydown(key("ArrowDown"));
    expect(palette.cursor.value).toBe(4);
    palette.query.value = "sw";
    expect(palette.cursor.value).toBe(0);
    expect(palette.rows.value.map((r) => r.command.id)).toEqual(["graph-focus", "review-focus"]);
    palette.onKeydown(key("Enter"));
    await Promise.resolve();
    expect(acts.calls).toEqual(["graph"]);
  });

  it("reports the empty state when nothing matches", () => {
    const { palette } = setup();
    palette.query.value = "zzz";
    expect(palette.rows.value).toEqual([]);
    expect(palette.isEmpty.value).toBe(true);
    expect(palette.onKeydown(key("Enter"))).toBe(true);
  });

  it("uses and updates the recents handed in by the caller", async () => {
    const acts = actions();
    const recents = ref<string[]>(["graph-focus"]);
    const palette = usePalette({
      commands: computed(() => paletteCommands(acts)),
      translate: (k) => labels[k] ?? k,
      onClose: () => {},
      recents,
    });
    expect(palette.rows.value[0]).toMatchObject({
      section: "recent",
      command: { id: "graph-focus" },
    });
    const row = palette.rows.value.find((r) => r.command.id === "open-editor");
    if (!row) throw new Error("missing open-editor");
    await palette.run(row);
    expect(recents.value).toEqual(["open-editor", "graph-focus"]);
  });

  it("reacts to command changes", () => {
    const acts = actions();
    const commands = ref(paletteCommands(acts));
    const palette = usePalette({ commands, translate: (k) => labels[k] ?? k, onClose: () => {} });
    commands.value = commands.value.slice(0, 2);
    expect(palette.rows.value).toHaveLength(2);
  });
});
