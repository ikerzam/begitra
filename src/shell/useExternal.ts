// "Open in terminal" and "Open in editor" for the current repository, for any indexed path,
// or for a file of a working tree at a line: the configured template first, then the
// platform fallbacks (for a line, the editor's at-line forms first); a failure becomes a
// toast with the command in its detail, a path not on disk a toast that names it.

import { useI18n } from "vue-i18n";

import { openExternal } from "@/ipc/commands";
import { toAppError } from "@/ipc/errors";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";
import { useToastsStore } from "@/stores/toasts";

import { joinPath } from "./joinPath";

export function useExternal() {
  const { t } = useI18n();
  const repo = useRepoStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();

  /**
   * Opens `path` with the terminal's or the editor's templates, at `line` in the editor; `shown`
   * is how a toast names the path (a file's repository-relative path).
   */
  async function open(
    kind: "terminal" | "editor",
    path: string | undefined,
    line: number | null = null,
    shown = path,
  ): Promise<boolean> {
    if (!path) return false;
    const templates =
      kind === "terminal"
        ? settings.terminalTemplates
        : line === null
          ? settings.editorTemplates
          : settings.editorLineTemplates;
    try {
      await openExternal(templates, path, line);
      return true;
    } catch (error) {
      const failure = toAppError(error);
      if (failure.code === "external.not_found") {
        toasts.push({ kind: "error", message: t("errors.notOnDisk", { path: shown }) });
        return false;
      }
      toasts.push({
        kind: "error",
        message: t(kind === "terminal" ? "external.terminalFailed" : "external.editorFailed"),
        action: t("external.showCommand"),
        output: failure.detail ?? failure.message,
      });
      return false;
    }
  }

  return {
    /** Opens the terminal at `path`, or at the open repository. */
    openTerminal: (path?: string) => open("terminal", path ?? repo.repo?.root),
    /** Opens the editor at `path`, or at the open repository. */
    openEditor: (path?: string) => open("editor", path ?? repo.repo?.root),
    /**
     * Opens the file at the repository-relative `path` of the working tree at `root` in the
     * editor, at `line` when given.
     */
    openFile: (root: string, path: string, line: number | null = null) =>
      open("editor", joinPath(root, path), line, path),
  };
}
