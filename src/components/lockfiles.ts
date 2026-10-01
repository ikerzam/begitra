// The lockfiles: the names the review hides with "Hide lockfiles", files under the rail's
// "Lockfile" type, and draws with the lock icon. The engine's flags (`git-core`'s `flags.rs`)
// count the same names as generated, so the two lists change together.

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "bun.lock",
  "bun.lockb",
]);

/** Whether the file a path names is a lockfile, by its exact name. */
export function isLockfile(path: string): boolean {
  return LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));
}
