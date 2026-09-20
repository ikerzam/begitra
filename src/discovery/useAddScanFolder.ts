// "Add folder": the native folder picker, then the index store adds the folder and scans it.
// A picker that cannot open becomes a toast, like "Open folder…".

import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "vue-i18n";

import { toAppError } from "@/ipc/errors";
import { useIndexStore } from "@/stores/index";
import { useToastsStore } from "@/stores/toasts";

export function useAddScanFolder() {
  const { t } = useI18n();
  const index = useIndexStore();
  const toasts = useToastsStore();

  /** Shows the picker; resolves with the chosen folder, or null when the user cancelled. */
  async function addScanFolder(): Promise<string | null> {
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
    index.addRoot(picked);
    return picked;
  }

  return { addScanFolder };
}
