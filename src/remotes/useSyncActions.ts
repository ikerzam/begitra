// Fetch, Pull and Push from a key or the palette: run as the buttons do, or say in a toast why
// they cannot, since a key press has no tooltip to show the reason.

import { useToastsStore } from "@/stores/toasts";

import { useSync } from "./useSync";
import { useSyncTexts } from "./useSyncTexts";

export type SyncAction = "fetch" | "pull" | "push";

export function useSyncActions() {
  const sync = useSync();
  const texts = useSyncTexts(sync);
  const toasts = useToastsStore();

  function act(action: SyncAction): void {
    const unavailable = texts[action].value.unavailable;
    if (unavailable) {
      toasts.push({ kind: "info", message: unavailable });
      return;
    }
    if (action === "fetch") void sync.runFetch();
    else if (action === "pull") void sync.runPull();
    else void sync.runPush();
  }

  return { act };
}
