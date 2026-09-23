import { describe, expect, it } from "vitest";

import { notesMarkdown } from "./notesMarkdown";

describe("notesMarkdown", () => {
  it("heads the notes with the target and puts each under its path, in path order", () => {
    const notes = new Map([
      ["src/worker.ts", "Ask about the retry."],
      ["src/cache.ts", "Check eviction.\nThe LRU never shrinks."],
    ]);
    expect(notesMarkdown("Review notes: main...agent/tiles", notes)).toBe(
      [
        "# Review notes: main...agent/tiles",
        "",
        "## `src/cache.ts`",
        "",
        "Check eviction.",
        "The LRU never shrinks.",
        "",
        "## `src/worker.ts`",
        "",
        "Ask about the retry.",
        "",
      ].join("\n"),
    );
  });

  it("keeps a path with a backtick readable", () => {
    const text = notesMarkdown("Notes", new Map([["docs/`odd`.md", "Rename it."]]));
    expect(text).toContain("## ``docs/`odd`.md``");
    // A backtick at an end needs a space inside the fence, or it merges with it.
    const edge = notesMarkdown("Notes", new Map([["`lead.md", "Why the tick?"]]));
    expect(edge).toContain("## `` `lead.md ``");
  });
});
