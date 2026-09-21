// What a discard asks to throw away, for the confirmation dialog of the changes screen.

import type { FileChange } from "@/ipc/schemas";

export type DiscardRequest =
  | { kind: "files"; files: FileChange[] }
  | { kind: "hunk"; file: FileChange; hunkIndex: number; keys: Set<string> }
  | { kind: "lines"; file: FileChange; keys: Set<string> };
