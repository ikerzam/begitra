// Whether the sidebar shows: its rail is there in every layout with a repository or a project
// open, and Home has none, so neither ⌘B nor the palette opens a panel there.

import { computed, type ComputedRef } from "vue";

import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";

export function useSidebarAvailable(): ComputedRef<boolean> {
  const repo = useRepoStore();
  const projects = useProjectsStore();
  return computed(() => repo.state.kind !== "empty" || projects.active !== null);
}
