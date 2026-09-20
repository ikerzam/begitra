// The actions a repository row offers (home table, sidebar, switcher): open, pin, forget,
// open in terminal or editor. One place, so every list behaves the same.

import type { IndexEntry } from "@/ipc/schemas";
import { useExternal } from "@/shell/useExternal";
import { useIndexStore } from "@/stores/index";

export function useRepoActions() {
  const index = useIndexStore();
  const external = useExternal();

  return {
    open: (entry: Pick<IndexEntry, "path">) => index.open(entry.path),
    togglePin: (entry: Pick<IndexEntry, "path" | "pinned">) => index.pin(entry.path, !entry.pinned),
    forget: (entry: Pick<IndexEntry, "path">) => index.forget(entry.path),
    openTerminal: (entry: Pick<IndexEntry, "path">) => external.openTerminal(entry.path),
    openEditor: (entry: Pick<IndexEntry, "path">) => external.openEditor(entry.path),
  };
}
