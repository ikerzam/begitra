// Why a bulk operation failed on a member, sorted from git's words: `LC_ALL=C` keeps
// them in English whatever the user's locale (the engine's `WRITE_ENV`). What matches none keeps
// git's first line; the whole output stays one click away.

import type { AppError } from "@/ipc/errors";
import { DIVERGED_PULL } from "@/remotes/gitWords";

import type { FailureReason } from "./run";

export interface Failure {
  reason: FailureReason;
  /** git's first line that says what went wrong. */
  message: string;
  /** Everything git printed, one click away in the row. */
  output: string;
}

/** In order: a sign-in's words come before the network's, since a refused sign-in over HTTPS
 * also reads "unable to access". */
const patterns: [FailureReason, RegExp][] = [
  [
    "sign-in",
    /Permission denied \(publickey|Host key verification failed|Authentication failed|could not read (Username|Password)|terminal prompts disabled|Cannot prompt because user interactivity has been disabled|Invalid username or password|HTTP Basic: Access denied|The requested URL returned error: 40[13]/i,
  ],
  [
    "rejected",
    /\[rejected\]|\[remote rejected\]|non-fast-forward|\(fetch first\)|pre-receive hook declined/,
  ],
  ["diverged", DIVERGED_PULL],
  ["local-changes", /would be overwritten|Please commit your changes or stash them/],
  ["branch-exists", /a branch named '.*' already exists/],
  [
    "network",
    /Could not resolve host|Failed to connect|Connection timed out|Connection refused|Network is unreachable|Operation timed out|unable to access/i,
  ],
];

/** The first line of `output` that says what failed: a `fatal:` or `error:` line, else the
 * first one that is not a hint. */
function firstLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.find((line) => /^(fatal|error):/.test(line)) ??
    lines.find((line) => !line.startsWith("hint:")) ??
    ""
  );
}

/** Sorts a member's failure by what git said. */
export function classifyFailure(error: AppError): Failure {
  const output = error.detail ?? error.message;
  const message = firstLine(output) || error.message;
  // A pull whose upstream left the remote: the engine names the ref (`refs.not_found`).
  if (error.code === "refs.not_found") return { reason: "upstream-gone", message, output };
  for (const [reason, pattern] of patterns) {
    if (pattern.test(output)) return { reason, message, output };
  }
  return { reason: "other", message, output };
}
