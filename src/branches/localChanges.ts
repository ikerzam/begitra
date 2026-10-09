// The files git names when it refuses a switch, a merge, a rebase or a pull over local changes
// (`git.local_changes`), read as git writes them under `LC_ALL=C`, which every write sets: the
// lines under each "would be overwritten by", "would be removed by" or "would lose untracked
// files in them" line, tab-indented one per line, or space-indented and space-separated on one
// line (merge-ort's refusal of staged changes). A path with a space reads as two on that line,
// so the line is matched against the paths that may be on it (the staged ones) when they are
// known. A rebase names none.

export interface LocalChangesIn {
  /** Changed tracked files git names. */
  changed: string[];
  /** Untracked files (or folders) git names, which no autostash takes. */
  untracked: string[];
  /** git says untracked files are in the way, whether or not it named them. */
  untrackedInTheWay: boolean;
}

const HEADER =
  /(?:would be (?:overwritten|removed) by (?:checkout|merge)|would lose untracked files in them):\s*$/;

/**
 * `line` as a sequence of the `known` paths separated by single spaces, or null when they do
 * not make it up; the paths that run longest are tried first.
 */
export function tiled(line: string, known: readonly string[]): string[] | null {
  const candidates = [...new Set(known)].filter((path) => path !== "");
  candidates.sort((a, b) => b.length - a.length);
  const from = new Map<number, string[] | null>();
  const tile = (start: number): string[] | null => {
    if (start === line.length) return [];
    const seen = from.get(start);
    if (seen !== undefined) return seen;
    let found: string[] | null = null;
    for (const path of candidates) {
      const end = start + path.length;
      if (!line.startsWith(path, start)) continue;
      if (end !== line.length && line[end] !== " ") continue;
      const rest = tile(end === line.length ? end : end + 1);
      if (rest) {
        found = [path, ...rest];
        break;
      }
    }
    from.set(start, found);
    return found;
  };
  return tile(0);
}

/** Whether git's words list paths on one space-separated line, which `known` paths resolve. */
export function listsOnOneLine(detail: string): boolean {
  return /\n {2}\S/.test(detail);
}

export function localChangesIn(detail: string, known: readonly string[] = []): LocalChangesIn {
  const changed: string[] = [];
  const untracked: string[] = [];
  let untrackedInTheWay = false;
  let list: string[] | null = null;
  for (const line of detail.split(/\r?\n/)) {
    if (HEADER.test(line)) {
      const isUntracked = /untracked/.test(line);
      untrackedInTheWay ||= isUntracked;
      list = isUntracked ? untracked : changed;
    } else if (list && line.startsWith("\t")) {
      list.push(line.slice(1));
    } else if (list && line.startsWith("  ") && line.trim() !== "") {
      const words = line.trim();
      list.push(...(tiled(words, known) ?? words.split(" ").filter((path) => path !== "")));
    } else {
      list = null;
    }
  }
  return { changed, untracked, untrackedInTheWay };
}
