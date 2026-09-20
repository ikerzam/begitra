// The sentence the interface shows for an `AppError`, by code, as an i18n key with params.

import type { AppError } from "@/ipc/errors";

export interface ErrorText {
  key: string;
  params: Record<string, string>;
}

export function errorText(error: Pick<AppError, "code" | "message">, path = ""): ErrorText {
  const params = { path, message: error.message };
  switch (error.code) {
    case "repo.not_found":
      return { key: "errors.repoNotFound", params };
    case "repo.invalid":
      return { key: "errors.repoInvalid", params };
    case "repo.corrupt_object":
      return { key: "errors.corruptObject", params };
    case "refs.not_found":
      return { key: "errors.refNotFound", params };
    case "op.cancelled":
      return { key: "errors.cancelled", params };
    case "op.timeout":
      return { key: "errors.timeout", params };
    case "git.not_started":
      return { key: "errors.gitNotStarted", params };
    case "git.cli_failed":
      return { key: "errors.gitFailed", params };
    case "external.spawn_failed":
      return { key: "errors.spawnFailed", params };
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
