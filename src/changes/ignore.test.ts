import { describe, expect, it } from "vitest";

import { ignoreLine, ignoreRules } from "./ignore";

describe("ignore rules", () => {
  it("offers the file, its extension when it has one and its folder when it is in one", () => {
    expect(ignoreRules("logs/debug.log")).toEqual(["file", "extension", "folder"]);
    expect(ignoreRules("debug.log")).toEqual(["file", "extension"]);
    expect(ignoreRules("logs/Makefile")).toEqual(["file", "folder"]);
    // A leading dot starts a hidden file's name, not an extension; a trailing one has none.
    expect(ignoreRules(".env")).toEqual(["file"]);
    expect(ignoreRules("notes.")).toEqual(["file"]);
  });

  it("writes each rule's line as the engine does", () => {
    expect(ignoreLine("logs/debug.log", "file")).toBe("/logs/debug.log");
    expect(ignoreLine("logs/debug.log", "extension")).toBe("*.log");
    expect(ignoreLine("logs/debug.log", "folder")).toBe("/logs/");
    expect(ignoreLine("a/b/c.txt", "folder")).toBe("/a/b/");
    expect(ignoreLine("archive.tar.gz", "extension")).toBe("*.gz");
    expect(ignoreLine(".env.local", "extension")).toBe("*.local");
    expect(ignoreLine("Makefile", "folder")).toBeNull();
    expect(ignoreLine(".env", "extension")).toBeNull();
  });

  it("keeps the slash of a folder git lists whole, a nested repository's", () => {
    expect(ignoreRules("nested/")).toEqual(["file"]);
    expect(ignoreRules("tools/clone.d/")).toEqual(["file", "folder"]);
    expect(ignoreLine("nested/", "file")).toBe("/nested/");
    expect(ignoreLine("tools/clone.d/", "file")).toBe("/tools/clone.d/");
    expect(ignoreLine("tools/clone.d/", "extension")).toBeNull();
    expect(ignoreLine("tools/clone.d/", "folder")).toBe("/tools/");
  });

  it("escapes the characters a pattern reads, so the line matches its name alone", () => {
    expect(ignoreLine("star*.txt", "file")).toBe("/star\\*.txt");
    expect(ignoreLine("q?.txt", "file")).toBe("/q\\?.txt");
    expect(ignoreLine("br[1].txt", "file")).toBe("/br\\[1].txt");
    expect(ignoreLine("back\\slash", "file")).toBe("/back\\\\slash");
    expect(ignoreLine("trail  ", "file")).toBe("/trail\\ \\ ");
    expect(ignoreLine("x.lo*", "extension")).toBe("*.lo\\*");
    // Anchored at the root, a leading `#` or `!` is neither a comment nor a negation.
    expect(ignoreLine("#notes.txt", "file")).toBe("/#notes.txt");
    expect(ignoreLine("!bang.txt", "file")).toBe("/!bang.txt");
  });
});
