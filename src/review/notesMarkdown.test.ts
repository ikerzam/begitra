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

  it("follows a resolved note with its resolution, the reply when there is one", () => {
    const notes = new Map([
      ["src/a.ts", "Handle the empty list."],
      ["src/b.ts", "Rename it."],
      ["src/c.ts", "Check the retry."],
    ]);
    const resolutions = new Map([
      ["src/a.ts", { reply: "Returns early on []." }],
      ["src/b.ts", { reply: "" }],
    ]);
    expect(notesMarkdown("Notes", notes, resolutions)).toBe(
      [
        "# Notes",
        "",
        "## `src/a.ts`",
        "",
        "Handle the empty list.",
        "",
        "**Resolved:** Returns early on [].",
        "",
        "## `src/b.ts`",
        "",
        "Rename it.",
        "",
        "**Resolved**",
        "",
        "## `src/c.ts`",
        "",
        "Check the retry.",
        "",
      ].join("\n"),
    );
    // The line is the caller's to word (the app's language).
    const spanish = notesMarkdown("Notas", notes, resolutions, (reply) => `**Resuelta:** ${reply}`);
    expect(spanish).toContain("**Resuelta:** Returns early on [].");
  });

  it("keeps a path with a backtick readable", () => {
    const text = notesMarkdown("Notes", new Map([["docs/`odd`.md", "Rename it."]]));
    expect(text).toContain("## ``docs/`odd`.md``");
    // A backtick at an end needs a space inside the fence, or it merges with it.
    const edge = notesMarkdown("Notes", new Map([["`lead.md", "Why the tick?"]]));
    expect(edge).toContain("## `` `lead.md ``");
  });
});
