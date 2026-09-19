// The frontend counterpart of the Rust `AppError`: one class the UI switches on by `code`.

import * as v from "valibot";

import { AppErrorSchema, type ErrorCode } from "./schemas";

export class AppError extends Error {
  readonly code: ErrorCode | (string & {});
  readonly detail: string | undefined;

  constructor(code: ErrorCode | (string & {}), message: string, detail?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }

  /** Whether the error carries one of the given codes. */
  is(...codes: ErrorCode[]): boolean {
    return (codes as string[]).includes(this.code);
  }

  toJSON(): { code: string; message: string; detail?: string } {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

const invalidArgs = /^invalid args `(\w+)` for command `(\w+)`: (.*)$/s;

/**
 * Turns whatever `invoke` rejected with into an `AppError`: a serialised `AppError` from Rust,
 * Tauri's own "invalid args" message (a payload that did not match the Rust type), or anything
 * else as `internal`.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const parsed = v.safeParse(AppErrorSchema, error);
  if (parsed.success) {
    return new AppError(parsed.output.code, parsed.output.message, parsed.output.detail);
  }
  if (typeof error === "string") {
    const match = invalidArgs.exec(error);
    if (match) {
      return new AppError("ipc.invalid_argument", `Invalid argument ${match[1]}`, match[3]);
    }
    return new AppError("internal", error);
  }
  if (error instanceof Error) {
    return new AppError("internal", error.message);
  }
  return new AppError("internal", "Unknown error", safeStringify(error));
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
