import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { paletteCommands, type PaletteActions } from "./commands";
import { matchesQuery, usePalette } from "./usePalette";

const labels: Record<string, string> = {
  "palette.commandsById.open-folder": "Open folder…",
  "palette.commandsById.graph-focus": "Switch to graph focus",
  "palette.commandsById.review-focus": "Switch to review focus",
  "palette.commandsById.toggle-sidebar": "Toggle sidebar",
  "palette.commandsById.open-terminal": "Open in terminal",
  "palette.commandsById.open-editor": "Open in editor",
  "palette.commandsById.close-repository": "Close repository",
  "palette.commandsById.locale-en": "Language: English",
  "palette.commandsById.locale-es": "Language: Spanish",
};

function actions(hasRepository = true): PaletteActions & { calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    hasRepository: () => hasRepository,
    openFolder: () => {
      calls.push("openFolder");
      return Promise.resolve();
    },
    closeRepository: () => {
      calls.push("closeRepository");
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
  function setup(hasRepository = true) {
    const acts = actions(hasRepository);
    const onClose = vi.fn();
    const palette = usePalette({
      commands: computed(() => paletteCommands(acts)),
      translate: (k) => labels[k] ?? k,
      onClose,
    });
    return { acts, onClose, palette };
  }

  it("lists every enabled command and filters by the query", () => {
    const { palette } = setup();
    expect(palette.rows.value.map((r) => r.command.id)).toEqual([
      "open-folder",
      "graph-focus",
      "review-focus",
      "toggle-sidebar",
      "open-terminal",
      "open-editor",
      "close-repository",
      "locale-en",
      "locale-es",
    ]);
    palette.query.value = "rev";
    expect(palette.rows.value.map((r) => r.label)).toEqual(["Switch to review focus"]);
    expect(palette.isEmpty.value).toBe(false);
  });

  it("hides repository commands without a repository", () => {
    const { palette } = setup(false);
    const ids = palette.rows.value.map((r) => r.command.id);
    expect(ids).not.toContain("open-terminal");
    expect(ids).not.toContain("close-repository");
    expect(ids).toContain("open-folder");
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
