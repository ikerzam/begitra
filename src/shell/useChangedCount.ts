// The Changes tab's count: the changed files of the open project's repositories as far as their
// lists are read, never under the open repository's own count, or the open repository's alone
// in a project of one.

import { computed, type ComputedRef } from "vue";

import { useChangesStore } from "@/stores/changes";
import { useFolderStore } from "@/stores/folder";
import { useProjectsStore } from "@/stores/projects";

export function useChangedCount(): ComputedRef<number> {
  const changes = useChangesStore();
  const folder = useFolderStore();
  const projects = useProjectsStore();
  return computed(() => {
    const own = changes.counts?.changed ?? 0;
    if (!projects.multi || folder.source !== projects.active?.id) return own;
    const read = folder.repositories.reduce(
      (sum, repository) => sum + (repository.view.counts?.changed ?? 0),
      0,
    );
    return Math.max(read, own);
  });
}
