// The shape of a branch or tag name git accepts (the bridge checks the same rules again).

const FORBIDDEN = /[\s~^:?*[\\]/;

export function validName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("-") || trimmed.length > 200) return false;
  if (FORBIDDEN.test(trimmed) || trimmed.includes("..") || trimmed.includes("@{")) return false;
  if (trimmed.endsWith("/") || trimmed.endsWith(".") || trimmed === "@") return false;
  return trimmed
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** A remote-tracking branch as the remote it belongs to and the branch on that remote. */
export interface RemoteBranch {
  remote: string;
  branch: string;
}

/**
 * The remote a remote-tracking branch belongs to: the listed remote whose name and a slash
 * start the ref's name, the longest winning, since a remote's name may hold a slash; null for
 * another kind of ref, or for a remote no longer listed.
 */
export function remoteOf(
  ref: { kind: string; name: string },
  remotes: readonly { name: string }[],
): RemoteBranch | null {
  if (ref.kind !== "remote-branch") return null;
  let best: string | null = null;
  for (const { name } of remotes) {
    if (ref.name.startsWith(`${name}/`) && (best === null || name.length > best.length)) {
      best = name;
    }
  }
  return best === null ? null : { remote: best, branch: ref.name.slice(best.length + 1) };
}
