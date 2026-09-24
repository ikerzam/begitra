/**
 * Reloads of a change list driven by the watcher: which paths a list reads again, how a
 * restricted result replaces what it covers, and one queue per list so reloads never overlap.
 * The rules match the engine's (`git2_engine/diff.rs`, `covers` and the listing order), so a
 * list read again at some paths equals a full reload.
 */
import type { FileChange, RepoChanged } from "@/ipc/schemas";

/** Most paths a restricted reload asks for; more reload the list in full. */
export const MAX_RESTRICTED_PATHS = 200;

/** Files whose change alters how every other file lists: the list reloads in full. */
const RULE_FILES = new Set([".gitignore", ".gitattributes", ".gitmodules"]);

/** What a list reads again: everything, some paths, or nothing. */
export type Reload = { kind: "full" } | { kind: "paths"; paths: string[] } | { kind: "none" };

const trim = (path: string): string => (path.endsWith("/") ? path.slice(0, -1) : path);

const below = (path: string, folder: string): boolean =>
  path.length > folder.length && path.startsWith(folder) && path[folder.length] === "/";

/**
 * Whether a requested path covers a listed one: the same path, one below it, or an entry above
 * it (a folder entry, a submodule, a file turned into a folder), whose listing a change inside
 * it can move.
 */
export function covers(requested: string, listed: string): boolean {
  const path = trim(requested);
  const entry = trim(listed);
  return entry === path || below(entry, path) || below(path, entry);
}

function coveredFile(file: FileChange, paths: string[]): boolean {
  return paths.some(
    (path) => covers(path, file.path) || (file.oldPath !== null && covers(path, file.oldPath)),
  );
}

/**
 * Orders two paths as the engine lists files: by their UTF-8 bytes, which is code point order.
 * UTF-16 differs from it only for a character above U+FFFF (a surrogate pair) against one of
 * U+E000 to U+FFFF.
 */
export function comparePaths(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const xs = x >= 0xd800 && x <= 0xdfff;
      const ys = y >= 0xd800 && y <= 0xdfff;
      if (xs !== ys) return xs ? 1 : -1;
      return x - y;
    }
  }
  return a.length - b.length;
}

/**
 * The paths a restricted reload of `files` asks for after `changed`: those paths, the listed
 * entries they touch (a folder entry or a submodule above them, both sides of a rename), and,
 * for a list that pairs renames, every listed addition and deletion, so a pair that forms or
 * breaks is found as a full reload finds it.
 */
export function requestedPaths(files: FileChange[], changed: string[], renames: boolean): string[] {
  const requested = new Set(changed.map(trim));
  for (const file of files) {
    const sides = file.oldPath === null ? [file.path] : [file.path, file.oldPath];
    const touched = sides.some((side) => changed.some((path) => covers(path, side)));
    if (touched || (renames && (file.status === "added" || file.status === "deleted"))) {
      for (const side of sides) requested.add(trim(side));
    }
  }
  return [...requested];
}

/** The list after a restricted reload at `paths`: what they cover leaves, `fresh` joins. */
export function mergeRestricted(
  files: FileChange[],
  paths: string[],
  fresh: FileChange[],
): FileChange[] {
  const replaced = new Set(fresh.map((file) => file.path));
  const kept = files.filter((file) => !replaced.has(file.path) && !coveredFile(file, paths));
  return kept.concat(fresh).sort((a, b) => comparePaths(a.path, b.path));
}

/** A path whose change reloads every list in full (`.gitignore`, `.gitattributes`, `.gitmodules`). */
function isRuleFile(path: string): boolean {
  const name = trim(path).split("/").pop() ?? "";
  return RULE_FILES.has(name);
}

/**
 * What a list reads again after `change`. A list that `readsWorkingTree` follows the working
 * tree's paths; every list follows the index entries. Unknown paths, a rule file among them or
 * more than [`MAX_RESTRICTED_PATHS`] reload it in full.
 */
export function reloadFor(change: RepoChanged, readsWorkingTree: boolean): Reload {
  const paths = new Set<string>();
  if (readsWorkingTree && change.kinds.includes("status")) {
    if (change.paths.length === 0) return { kind: "full" };
    for (const path of change.paths) paths.add(path);
  }
  if (change.kinds.includes("index")) {
    if (change.indexPaths === null) return { kind: "full" };
    for (const path of change.indexPaths) paths.add(path);
  }
  if (paths.size === 0) return { kind: "none" };
  if (paths.size > MAX_RESTRICTED_PATHS || [...paths].some(isRuleFile)) return { kind: "full" };
  return { kind: "paths", paths: [...paths] };
}

/** Two waiting reloads as one: a full one absorbs any other, paths join. */
export function mergeReloads(a: Reload | null, b: Reload): Reload {
  if (a === null || a.kind === "none") return b;
  if (b.kind === "none") return a;
  if (a.kind === "full" || b.kind === "full") return { kind: "full" };
  return { kind: "paths", paths: [...new Set([...a.paths, ...b.paths])] };
}

/** How a list reloads: in full, or at some paths (false when that lists too many files). */
export interface ReloadRunners {
  full: () => Promise<void>;
  paths: (paths: string[]) => Promise<boolean>;
}

/**
 * The reloads of one list, one at a time: a full reload starts at once (the list's own stream
 * cancels the one it replaces) and absorbs what waits; restricted ones wait for what runs and
 * merge while they wait, since a full reload may have read the tree before their change.
 * `hold` keeps requests waiting while a write runs.
 */
export class Reloader {
  private running: Promise<void> | null = null;
  private pending: Reload | null = null;
  private held = false;

  constructor(private readonly runners: ReloadRunners) {}

  request(reload: Reload): void {
    if (reload.kind === "none") return;
    this.pending = mergeReloads(this.pending, reload);
    if (reload.kind === "full" && !this.held) {
      this.pending = null;
      this.start({ kind: "full" });
      return;
    }
    this.next();
  }

  /** Keeps requests waiting (a write runs). */
  hold(): void {
    this.held = true;
  }

  /** Runs what waited. */
  resume(): void {
    this.held = false;
    this.next();
  }

  /** Forgets what waits (another repository opened). */
  clear(): void {
    this.pending = null;
  }

  /** Resolves once nothing runs or waits (for tests and writes that await their reload). */
  async settled(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  private next(): void {
    if (this.running !== null || this.held || this.pending === null) return;
    const reload = this.pending;
    this.pending = null;
    this.start(reload);
  }

  private start(reload: Reload): void {
    const run =
      reload.kind === "full"
        ? this.runners.full()
        : reload.kind === "paths"
          ? this.runners.paths(reload.paths).then((listed) => {
              if (!listed) this.pending = mergeReloads(this.pending, { kind: "full" });
            })
          : Promise.resolve();
    const running = run
      .catch(() => {
        // The runner reports its own failure on the list.
      })
      .finally(() => {
        if (this.running === running) this.running = null;
        this.next();
      });
    this.running = running;
  }
}
