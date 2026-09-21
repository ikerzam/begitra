// The update check of the About section: nothing runs unless the user
// asks. `check` asks the updater plugin (the endpoint and the public key of
// `tauri.conf.json`), `install` downloads and installs the version found with its progress
// in the status bar, and `restart` relaunches. On Windows the plugin's install exits the app
// itself once the installer starts; elsewhere "Restart" does it. A failure of any step is
// `updater.failed` with the plugin's words in the detail, and the control stays available.

import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { defineStore } from "pinia";
import { ref } from "vue";

import { AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";

import { useOperationsStore } from "./operations";

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; version: string; body: string | null }
  | { kind: "downloading"; version: string }
  | { kind: "installed"; version: string }
  | { kind: "failed"; error: AppError };

/** The plugin's failure as an `AppError`: its words as the message and the detail. */
export function updaterError(failure: unknown): AppError {
  const words =
    failure instanceof Error
      ? failure.message
      : typeof failure === "string"
        ? failure
        : JSON.stringify(failure);
  return new AppError("updater.failed", words, words);
}

export const useUpdaterStore = defineStore("updater", () => {
  const operations = useOperationsStore();

  const state = ref<UpdaterState>({ kind: "idle" });
  /** The update the last check found, kept out of the reactive state (a plugin resource). */
  let found: Update | null = null;

  /** Asks the endpoint; "up to date" when it names nothing newer. */
  async function check(): Promise<void> {
    if (state.value.kind === "checking" || state.value.kind === "downloading") return;
    state.value = { kind: "checking" };
    try {
      const update = await checkForUpdate();
      found = update;
      state.value = update
        ? { kind: "available", version: update.version, body: update.body ?? null }
        : { kind: "upToDate" };
    } catch (failure) {
      found = null;
      state.value = { kind: "failed", error: updaterError(failure) };
    }
  }

  /** Downloads and installs the version found, its progress in the status bar. */
  async function install(): Promise<void> {
    const update = found;
    if (!update || state.value.kind !== "available") return;
    const version = update.version;
    state.value = { kind: "downloading", version };
    const opId = newOpId("update");
    operations.start(opId, "operations.downloadingUpdate", undefined, { params: { version } });
    let done = 0;
    let total: number | undefined;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          if (total !== undefined) operations.progress(opId, 0, total);
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          if (total !== undefined) operations.progress(opId, done, total);
        }
      });
      state.value = { kind: "installed", version };
    } catch (failure) {
      state.value = { kind: "failed", error: updaterError(failure) };
    } finally {
      operations.finish(opId);
    }
  }

  /** Relaunches into the installed version. */
  async function restart(): Promise<void> {
    try {
      await relaunch();
    } catch (failure) {
      state.value = { kind: "failed", error: updaterError(failure) };
    }
  }

  function dismiss(): void {
    if (state.value.kind === "failed" || state.value.kind === "upToDate") {
      state.value = { kind: "idle" };
    }
  }

  return { state, check, install, restart, dismiss };
});
