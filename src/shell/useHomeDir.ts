// The user's home folder, so paths read "~/code/geoportal". Asked once from
// Tauri; outside Tauri (tests, a browser) it stays unknown and paths show in full.

import { homeDir } from "@tauri-apps/api/path";
import { ref, type Ref } from "vue";

const home = ref<string | null>(null);
let requested = false;

export function useHomeDir(): Ref<string | null> {
  if (!requested) {
    requested = true;
    homeDir()
      .then((dir) => {
        home.value = typeof dir === "string" && dir.length > 0 ? dir : null;
      })
      .catch(() => {
        home.value = null;
      });
  }
  return home;
}
