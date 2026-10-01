// The order of the sidebar's ref sections: by the committer time of each ref's
// commit, most recent first, or by name, which is the order the engine lists (the full names'
// byte order, as git for-each-ref sorts). The sort is stable, so equal times keep the name
// order, and refs without a time come after the dated ones.

import type { Ref as GitRef } from "@/ipc/schemas";
import type { BranchSort } from "@/stores/settings";

/** `refs` in the order the setting asks for. */
export function sortRefs(refs: readonly GitRef[], order: BranchSort): GitRef[] {
  if (order === "name") return [...refs];
  return [...refs].sort((a, b) => {
    const left = a.committedAt;
    const right = b.committedAt;
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  });
}
