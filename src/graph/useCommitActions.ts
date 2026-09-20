// The actions of a commit row shared by the context menu, the hover card and the keyboard:
// copy the hash or the message (with a toast), pin the commit as the diff base or the range
// end, and open the repository in the terminal or the editor.

import { useI18n } from "vue-i18n";

import type { CommitNode } from "@/ipc/schemas";
import { shortHash } from "@/shell/format";
import { useExternal } from "@/shell/useExternal";
import { useGraphStore } from "@/stores/graph";
import { usePickerStore } from "@/stores/picker";
import { useToastsStore } from "@/stores/toasts";

/** Writes `text` to the clipboard; false when the webview offers none. */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function useCommitActions() {
  const { t } = useI18n();
  const graph = useGraphStore();
  const toasts = useToastsStore();
  const external = useExternal();
  const picker = usePickerStore();

  async function copy(text: string, doneKey: string, params: Record<string, string>) {
    if (await copyText(text)) {
      toasts.push({ kind: "success", message: t(doneKey, params) });
    } else {
      toasts.push({ kind: "error", message: t("graph.clipboardUnavailable") });
    }
  }

  return {
    copyHash: (commit: CommitNode) =>
      copy(commit.hash, "graph.hashCopied", { hash: shortHash(commit.hash) }),
    copyMessage: (commit: CommitNode) =>
      copy(
        commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject,
        "graph.messageCopied",
        {},
      ),
    diffFrom: (commit: CommitNode) => graph.setDiffBase(commit.hash),
    compareWith: (commit: CommitNode) =>
      picker.open({
        kind: "compare",
        side: "b",
        other: { kind: "revision", rev: commit.hash, label: shortHash(commit.hash) },
      }),
    rangeEnd: (commit: CommitNode) => graph.setRangeEnd(commit.hash),
    openTerminal: () => external.openTerminal(),
    openEditor: () => external.openEditor(),
  };
}
