// The find in the diff over the changes screen's lists, while their viewer shows: the Unstaged
// list's files and then the Staged list's, keyed by list and path (a file in both is searched
// in both), opened as a click on their row; ⌘F, F3 and ⇧F3 reach it.

import { computed, onBeforeUnmount, onMounted } from "vue";

import type { FindFile } from "@/review/find";
import { selectedQuery } from "@/review/selectedQuery";
import { outsideOverlays } from "@/shortcuts/registry";
import { useShortcut } from "@/shortcuts/useShortcut";
import type { ChangeList } from "@/stores/changes";
import { useFindStore } from "@/stores/find";

import type { ChangesView } from "./useChanges";

const LISTS: readonly ChangeList[] = ["unstaged", "staged"];

/** The key the find names a list's file by. */
export function findKeyOf(list: ChangeList, path: string): string {
  return `${list}\u0000${path}`;
}

/** Makes `changes`' lists what the find searches; `reveal` shows a file past its card. */
export function useChangesFind(changes: ChangesView, reveal: (path: string) => void): void {
  const find = useFindStore();
  const files = computed<FindFile[]>(() =>
    LISTS.flatMap((list) =>
      changes[list].files.map((file) => ({
        key: findKeyOf(list, file.path),
        path: file.path,
        hunks: file.hunks,
      })),
    ),
  );

  let release: (() => void) | null = null;
  onMounted(() => {
    release = find.attach({
      files: () => files.value,
      open: (entry) => {
        const list = LISTS.find((candidate) => entry.key === findKeyOf(candidate, entry.path));
        if (!list) return;
        const file = changes[list].files.find((candidate) => candidate.path === entry.path);
        if (file && (file.isLarge || file.isGenerated)) reveal(entry.path);
        const selected = changes.selected;
        if (selected?.list !== list || selected.path !== entry.path) {
          changes.select(list, entry.path);
        }
      },
      shownKey: () => {
        const selected = changes.selected;
        return selected ? findKeyOf(selected.list, selected.path) : null;
      },
      loading: () => changes.unstaged.loading || changes.staged.loading,
    });
  });
  onBeforeUnmount(() => release?.());

  useShortcut(
    "find",
    outsideOverlays(() => find.show(selectedQuery())),
  );
  useShortcut(
    "find-next",
    outsideOverlays(() => find.next()),
  );
  useShortcut(
    "find-previous",
    outsideOverlays(() => find.previous()),
  );
}
