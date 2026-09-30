// The folder view's watchers applied at a pace: a repository's changes reach its lists at most
// once a period, the changes of the meantime merged into one that reads everything they named.

import type { RepoChanged } from "@/ipc/schemas";

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/** A working-tree change that could not name its paths: the list reads whole. */
const unknownPaths = (change: RepoChanged): boolean =>
  change.kinds.includes("status") && change.paths.length === 0;

/** An index change that could not name its entries. */
const unknownIndex = (change: RepoChanged): boolean =>
  change.kinds.includes("index") && change.indexPaths === null;

/**
 * Two changes of one repository as one: the kinds and the named paths joined, and a side that
 * could not name its paths (or entries) keeping the merge unknown, so the list reads whole.
 */
export function mergeChanges(a: RepoChanged, b: RepoChanged): RepoChanged {
  return {
    repo: a.repo,
    kinds: [...new Set([...a.kinds, ...b.kinds])],
    paths: unknownPaths(a) || unknownPaths(b) ? [] : union(a.paths, b.paths),
    indexPaths:
      unknownIndex(a) || unknownIndex(b) ? null : union(a.indexPaths ?? [], b.indexPaths ?? []),
    conflictsChanged: a.conflictsChanged || b.conflictsChanged,
  };
}

/** Applies each repository's changes at most once every `period` milliseconds. */
export class Pacer {
  private readonly last = new Map<string, number>();
  private readonly waiting = new Map<
    string,
    { change: RepoChanged; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly period: number,
    private readonly apply: (change: RepoChanged) => void,
  ) {}

  /** Applies `change` now, or merges it into what waits for the repository's next turn. */
  push(change: RepoChanged): void {
    const root = change.repo;
    const held = this.waiting.get(root);
    if (held) {
      held.change = mergeChanges(held.change, change);
      return;
    }
    const since = Date.now() - (this.last.get(root) ?? Number.NEGATIVE_INFINITY);
    if (since >= this.period) {
      this.last.set(root, Date.now());
      this.apply(change);
      return;
    }
    const timer = setTimeout(() => this.flush(root), this.period - since);
    this.waiting.set(root, { change, timer });
  }

  /** Forgets what waits and when each repository was last served (leaving the view). */
  clear(): void {
    for (const held of this.waiting.values()) clearTimeout(held.timer);
    this.waiting.clear();
    this.last.clear();
  }

  private flush(root: string): void {
    const held = this.waiting.get(root);
    if (!held) return;
    this.waiting.delete(root);
    this.last.set(root, Date.now());
    this.apply(held.change);
  }
}
