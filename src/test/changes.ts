// A changed file for the tests of the changes screen: one hunk of a context line, a removed
// line and two added lines, with the flags a text file carries.

import type { DiffLine, FileChange } from "@/ipc/schemas";

function line(kind: DiffLine["kind"], n: number, text: string): DiffLine {
  return {
    kind,
    oldNumber: kind === "added" ? null : n,
    newNumber: kind === "removed" ? null : n,
    text,
    spans: [],
    noNewline: false,
  };
}

export function changedFile(path: string, extra: Partial<FileChange> = {}): FileChange {
  return {
    status: "modified",
    path,
    oldPath: null,
    similarity: null,
    additions: 2,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        header: "@@ -1,2 +1,3 @@ fn main",
        lines: [
          line("context", 1, "fn main() {"),
          line("removed", 2, "    old();"),
          line("added", 2, "    new();"),
          line("added", 3, "    more();"),
        ],
      },
    ],
    isBinary: false,
    isLarge: false,
    isGenerated: false,
    isTest: false,
    isLossy: false,
    oldId: null,
    newId: null,
    ...extra,
  };
}
