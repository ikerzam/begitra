// The refs a pattern scope walks: the local branches whose name matches a glob, and the remote
// branches whose name on their remote does (`claude/*` takes `claude/fix-auth` and
// `origin/claude/fix-auth`). The glob reads `/`-separated segments: `*` within a segment, `**`
// across segments, `?` one character, the rest literally and case and all, as git's ref names.

import { remoteOf } from "@/branches/names";
import type { Ref as GitRef } from "@/ipc/schemas";

const SPECIAL = /[.+^${}()|[\]\\]/g;

/** The glob as a regular expression over a whole branch name. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === "*" && pattern.charAt(index + 1) === "*") {
      index += 1;
      if (pattern.charAt(index + 1) === "/") {
        // `**/` is any number of whole segments, none included.
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(SPECIAL, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * The full names of the branches `pattern` matches, in the refs' order: a remote branch by its
 * name on the listed remote it belongs to, or past its first segment while the remotes are not
 * listed. An empty pattern matches nothing.
 */
export function patternNames(
  pattern: string,
  refs: readonly GitRef[],
  remotes: readonly { name: string }[],
): string[] {
  const glob = pattern.trim();
  if (glob === "") return [];
  const matcher = globToRegExp(glob);
  const names: string[] = [];
  for (const ref of refs) {
    if (ref.kind === "local-branch") {
      if (matcher.test(ref.name)) names.push(ref.fullName);
    } else if (ref.kind === "remote-branch") {
      const onRemote =
        remotes.length > 0
          ? remoteOf(ref, remotes)?.branch
          : ref.name.slice(ref.name.indexOf("/") + 1);
      if (onRemote !== undefined && matcher.test(onRemote)) names.push(ref.fullName);
    }
  }
  return names;
}
