// "Open folder…": the native folder picker of tauri-plugin-dialog, then the repository store.
// A picker that cannot open (a missing portal, a capability mismatch) becomes a toast.

import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";

import { toAppError } from "@/ipc/errors";
import { useRepoStore } from "@/stores/repo";
import { useToastsStore } from "@/stores/toasts";

export function useOpenFolder() {
  const { t } = useI18n();
  const repo = useRepoStore();
  const toasts = useToastsStore();

  /** Shows the picker; resolves with the chosen path, or null when the user cancelled. */
  async function openFolder(): Promise<string | null> {
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
    if (typeof picked !== "string" || picked.length === 0) return null;
    await repo.open(picked);
    return picked;
  }

  return { openFolder };
}
