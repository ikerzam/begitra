// The folder view's keys: j and k walk the rows of every open section in
// order, entering the next section on its first row (or the one before on its last) and
// passing the closed sections and those that draw no row; s, u and Backspace act on the picked
// lines, else on the selected file, in its repository, a discard confirming once; ⌘↵ commits
// the box's repository.

import type { Ref } from "vue";

import type { useDiscardDialog } from "@/changes/useDiscardDialog";
import { useShortcut } from "@/shortcuts/useShortcut";
import type { useFolderStore } from "@/stores/folder";

/** What the view asks of a section's lists. */
export interface SectionHandle {
  focus(): void;
  moveFile(step: 1 | -1): boolean;
  selectEdge(edge: "first" | "last"): boolean;
}

export function useFolderKeys(options: {
  folder: ReturnType<typeof useFolderStore>;
  discard: ReturnType<typeof useDiscardDialog>;
  viewer: Ref<{ actOnSelection(action: "stage" | "unstage" | "discard"): boolean } | null>;
}) {
  const { folder, discard, viewer } = options;
  const sections = new Map<string, SectionHandle>();

  function setSection(root: string, handle: unknown): void {
    if (handle) sections.set(root, handle as SectionHandle);
    else sections.delete(root);
  }

  /**
   * Enters the section after (or before) `from` on its first (or last) row, passing the closed
   * sections and those that draw no row to take the selection.
   */
  function enterNext(from: string, step: 1 | -1): void {
    const order = folder.sections;
    const at = order.findIndex((section) => section.root === from);
    if (at === -1) return;
    for (let next = at + step; next >= 0 && next < order.length; next += step) {
      const section = order[next];
      if (!section || folder.collapsed.has(section.root)) continue;
      if (!sections.get(section.root)?.selectEdge(step === 1 ? "first" : "last")) continue;
      folder.activate(section.root);
      return;
    }
  }

  /** j/k from anywhere on the screen: the selection moves on, into the next section at its end. */
  function moveFile(step: 1 | -1): void {
    const active = folder.active;
    if (!active) return;
    if (folder.collapsed.has(active.root) || !sections.get(active.root)?.moveFile(step)) {
      enterNext(active.root, step);
    }
  }

  /** s, u, Backspace: the picked lines first, else the selected file of the matching list. */
  function actOnSelected(action: "stage" | "unstage" | "discard"): void {
    const active = folder.active;
    const view = active?.view;
    if (!active || !view || view.busy !== null || discard.pending.value !== null) return;
    if (viewer.value?.actOnSelection(action)) return;
    const current = view.selected;
    const file = view.selectedFile;
    if (!current || !file) return;
    if (action === "stage" && current.list === "unstaged") void view.stage([file.path]);
    else if (action === "unstage" && current.list === "staged") void view.unstage([file.path]);
    else if (action === "discard" && current.list === "unstaged") {
      discard.ask(view, { kind: "files", files: [file] }, active.name);
    }
  }

  /** The focus goes to the lists of the section the selection is in. */
  function focusActive(): void {
    const active = folder.active;
    if (active) sections.get(active.root)?.focus();
  }

  useShortcut("next-file", () => moveFile(1));
  useShortcut("previous-file", () => moveFile(-1));
  useShortcut("stage-file", () => actOnSelected("stage"));
  useShortcut("unstage-file", () => actOnSelected("unstage"));
  useShortcut("discard-file", () => actOnSelected("discard"));
  useShortcut("commit", () => void folder.active?.view.commit());

  return { setSection, enterNext, focusActive };
}
