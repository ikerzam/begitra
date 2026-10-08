// The sentence the interface shows for an `AppError`, by code, as an i18n key with params.

import type { AppError } from "@/ipc/errors";

export interface ErrorText {
  key: string;
  params: Record<string, string>;
}

export function errorText(
  error: Pick<AppError, "code" | "message"> & { detail?: string | null },
  path = "",
): ErrorText {
  const params = { path, message: error.message };
  // git could not take `index.lock`: another git holds the index, or a killed one left the
  // file behind; the sentence names the file so the user can clear a stale one.
  if (error.code === "git.cli_failed" && error.detail?.includes("index.lock")) {
    return { key: "errors.indexLock", params };
  }
  switch (error.code) {
    case "repo.not_found":
      return { key: "errors.repoNotFound", params };
    case "repo.invalid":
      return { key: "errors.repoInvalid", params };
    case "repo.corrupt_object":
      return { key: "errors.corruptObject", params };
    case "refs.not_found":
      return { key: "errors.refNotFound", params };
    case "refs.head_moved":
      return { key: "errors.headMoved", params };
    case "refs.head_held":
      return { key: "errors.headHeld", params };
    case "op.cancelled":
      return { key: "errors.cancelled", params };
    case "op.timeout":
      return { key: "errors.timeout", params };
    case "git.not_started":
      return { key: "errors.gitNotStarted", params };
    case "git.cli_failed":
      return { key: "errors.gitFailed", params };
    case "stash.not_found":
      return { key: "errors.stashNotFound", params };
    case "conflict.not_conflicted":
      return { key: "errors.notConflicted", params };
    case "conflict.gone":
      return { key: "errors.conflictGone", params };
    case "conflict.submodule":
      return { key: "errors.submoduleConflict", params };
    case "ignore.invalid_path":
      return { key: "errors.ignoreInvalidPath", params };
    case "ignore.write_failed":
      return { key: "errors.ignoreWriteFailed", params };
    case "discard.too_large":
      return { key: "errors.discardTooLarge", params };
    case "discard.not_a_file":
      return { key: "errors.discardNotAFile", params: { ...params, path: error.detail ?? path } };
    case "discard.behind_link":
      return { key: "errors.discardBehindLink", params: { ...params, path: error.detail ?? path } };
    case "discard.copy_failed":
      return { key: "errors.discardCopyFailed", params: { ...params, reason: error.detail ?? "" } };
    case "discard.copy_gone":
      return { key: "errors.discardCopyGone", params };
    case "external.spawn_failed":
      return { key: "errors.spawnFailed", params };
    case "external.not_found":
      return { key: "errors.notOnDisk", params: { ...params, path: error.detail ?? path } };
    case "external.refused":
      return { key: "errors.externalRefused", params };
    case "index.database":
      return { key: "errors.indexDatabase", params };
    case "index.folder":
      return { key: "errors.indexFolder", params };
    case "watcher.unavailable":
      return { key: "errors.watcherUnavailable", params };
    default:
      return { key: "errors.generic", params };
  }
}
