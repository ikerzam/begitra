// "Open folder…": the native folder picker of tauri-plugin-dialog, then the repository store.

import { open } from "@tauri-apps/plugin-dialog";

import { useRepoStore } from "@/stores/repo";

export function useOpenFolder() {
  const repo = useRepoStore();

  /** Shows the picker; resolves with the chosen path, or null when the user cancelled. */
  async function openFolder(): Promise<string | null> {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string" || picked.length === 0) return null;
    await repo.open(picked);
    return picked;
  }

  return { openFolder };
}
