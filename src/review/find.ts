// The find in the diff's matching: a query's occurrences in the lines of a file's hunks, as plain
// text, ignoring case unless asked. Offsets are UTF-16 units of the line's text; matches do not
// overlap, and each line of a hunk (removed, context or added) is searched once.

import type { Hunk } from "@/ipc/schemas";

/** A file of the change set as the find reads it. */
export interface FindFile {
  /** The file's key in its viewer: the path, or the list and the path on the Changes screen. */
  key: string;
  path: string;
  hunks: Hunk[];
}

export interface FindMatch {
  key: string;
  /** The hunk and the line inside it. */
  hunk: number;
  line: number;
  /** UTF-16 offsets in the line's text, `end` excluded. */
  start: number;
  end: number;
}

/**
 * `text` in lower case, one code point at a time and keeping each one's length, so offsets in
 * the folded text are offsets in `text`: a code point whose lower case is longer (İ) stays.
 */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let folded = "";
  for (const char of text) {
    const one = char.toLowerCase();
    folded += one.length === char.length ? one : char;
  }
  return folded;
}

/** The matches of `query` in `file`, in the order its lines show. */
export function matchFile(file: FindFile, query: string, matchCase: boolean): FindMatch[] {
  const matches: FindMatch[] = [];
  if (query === "") return matches;
  const needle = matchCase ? query : foldCase(query);
  for (const [h, hunk] of file.hunks.entries()) {
    for (const [l, line] of hunk.lines.entries()) {
      const text = matchCase ? line.text : foldCase(line.text);
      let at = text.indexOf(needle);
      while (at >= 0) {
        matches.push({ key: file.key, hunk: h, line: l, start: at, end: at + needle.length });
        at = text.indexOf(needle, at + needle.length);
      }
    }
  }
  return matches;
}
