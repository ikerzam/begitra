// Typed, validated wrapper over Tauri's `invoke`: arguments are checked against their schema
// before anything reaches Rust (a mismatch fails with `ipc.invalid_argument` naming the field
// and no engine work starts), and results are checked on the way back.

import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";

import { AppError, toAppError } from "./errors";
import { commandArgs, type CommandName } from "./schemas";

let opCounter = 0;

/** A fresh operation id: unique within the session and readable in logs. */
export function newOpId(prefix = "op"): string {
  opCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${opCounter}`;
}

/** The first offending field of a validation failure, dotted, or "payload" for the root. */
export function issueField(issues: v.BaseIssue<unknown>[]): string {
  const first = issues[0];
  const path = first?.path?.map((item) => String(item.key)).join(".");
  return path && path.length > 0 ? path : "payload";
}

/** Validates `args` for `command`; throws `ipc.invalid_argument` with the field in `detail`. */
export function checkArgs<TCommand extends CommandName>(
  command: TCommand,
  args: v.InferInput<(typeof commandArgs)[TCommand]>,
): v.InferOutput<(typeof commandArgs)[TCommand]> {
  const result = v.safeParse(commandArgs[command], args);
  if (!result.success) {
    const field = issueField(result.issues);
    throw new AppError(
      "ipc.invalid_argument",
      `Invalid argument ${field} for ${command}`,
      `${field}: ${result.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.output;
}

/** Calls `command` with validated `args` and validates the result against `resultSchema`. */
export async function call<TCommand extends CommandName, TResult extends v.GenericSchema>(
  command: TCommand,
  args: v.InferInput<(typeof commandArgs)[TCommand]>,
  resultSchema: TResult,
): Promise<v.InferOutput<TResult>> {
  const checked = checkArgs(command, args);
  let raw: unknown;
  try {
    raw = await invoke(command, checked as Record<string, unknown>);
  } catch (error) {
    throw toAppError(error);
  }
  const result = v.safeParse(resultSchema, raw);
  if (!result.success) {
    throw new AppError(
      "internal",
      `Unexpected result from ${command}`,
      `${issueField(result.issues)}: ${result.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.output;
}
