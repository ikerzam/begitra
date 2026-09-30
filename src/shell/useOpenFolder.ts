// "Open folder…" and "Add folder": the native folder picker of tauri-plugin-dialog, then the
// projects store. Open folder… opens the project of the repository the folder lies in (a project
// of one made for it when none holds it), or the folder's own project when it lies in none; Add
// folder makes the folder's project and scans it, whatever the folder lies in. A picker that
// cannot open (a missing portal, a capability mismatch) becomes a toast.

import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";

import { toAppError } from "@/ipc/errors";
import { useProjectsStore } from "@/stores/projects";
import { useToastsStore } from "@/stores/toasts";

export function useOpenFolder() {
  const { t } = useI18n();
  const projects = useProjectsStore();
  const toasts = useToastsStore();

  /** Shows the picker; resolves with the chosen folder, or null when the user cancelled. */
  async function pickFolder(): Promise<string | null> {
    let picked: unknown;
    try {
      picked = await open({ directory: true, multiple: false });
    } catch (error) {
      const failure = toAppError(error);
      toasts.push({
        kind: "error",
        message: t("home.pickerFailed"),
        output: failure.detail ?? failure.message,
      });
      return null;
    }
    return typeof picked === "string" && picked.length > 0 ? picked : null;
  }

  /** "Open folder…": resolves with the chosen path, or null when the user cancelled. */
  async function openFolder(): Promise<string | null> {
    const picked = await pickFolder();
    if (picked !== null) await projects.openPath(picked);
    return picked;
  }

  /** "Add folder": resolves with the chosen folder, or null when the user cancelled. */
  async function addFolder(): Promise<string | null> {
    const picked = await pickFolder();
    if (picked !== null) await projects.createFolder(picked);
    return picked;
  }

  return { openFolder, addFolder };
}
