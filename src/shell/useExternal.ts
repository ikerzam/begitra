// "Open in terminal" and "Open in editor" for the current repository: the configured template
// first, then the platform fallbacks; a failure becomes a toast with the command in its detail.

import { useI18n } from "vue-i18n";

import { openExternal } from "@/ipc/commands";
import { toAppError } from "@/ipc/errors";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";
import { useToastsStore } from "@/stores/toasts";

export function useExternal() {
  const { t } = useI18n();
  const repo = useRepoStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();

  async function open(kind: "terminal" | "editor"): Promise<boolean> {
    const path = repo.repo?.root;
    if (!path) return false;
    const templates = kind === "terminal" ? settings.terminalTemplates : settings.editorTemplates;
    try {
      await openExternal(templates, path);
      return true;
    } catch (error) {
      const failure = toAppError(error);
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
    openTerminal: () => open("terminal"),
    openEditor: () => open("editor"),
  };
}
