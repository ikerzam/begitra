// Typed listeners for events pushed from Rust: `repo:changed`, which the filesystem watcher
// of the open repository emits.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as v from "valibot";

import { RepoChangedSchema, type RepoChanged } from "./schemas";

export const REPO_CHANGED = "repo:changed";

/**
 * Subscribes to `repo:changed`. Payloads that do not match the schema are dropped and reported
 * through `onInvalid` (default: `console.error`), never delivered.
 */
export function onRepoChanged(
  handler: (change: RepoChanged) => void,
  onInvalid: (issue: string) => void = (issue) => console.error(issue),
): Promise<UnlistenFn> {
  return listen<unknown>(REPO_CHANGED, (event) => {
    const parsed = v.safeParse(RepoChangedSchema, event.payload);
    if (parsed.success) handler(parsed.output);
    else onInvalid(`Invalid ${REPO_CHANGED} payload: ${parsed.issues[0]?.message ?? "invalid"}`);
  });
}
