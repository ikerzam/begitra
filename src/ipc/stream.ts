// Streamed commands: pages arrive over a Tauri Channel as `{ kind: "page", seq, data }`
// messages, followed by exactly one `done` or `error`. `stream()` validates every page,
// forwards it to `onPage`, and settles `done` on the terminal message.

import { Channel, invoke } from "@tauri-apps/api/core";
import * as v from "valibot";

import { AppError, toAppError } from "./errors";
import { checkArgs, issueField, newOpId } from "./invoke";
import { streamMessageSchema, type CommandName, type commandArgs } from "./schemas";

export interface StreamHandle {
  /** Resolves on `done`, rejects with an `AppError` on `error` or when the call itself fails. */
  readonly done: Promise<void>;
  /** The operation id, for logs and for `cancel`. */
  readonly opId: string;
  /** Asks the backend to stop; `done` then rejects with `op.cancelled`. */
  cancel(): Promise<void>;
}

type StreamCommand = Extract<CommandName, "walk_commits" | "walk_continue" | "diff">;

const envelope = streamMessageSchema(v.unknown());

/**
 * Starts the streamed `command`. `args` must not contain `opId` or `onPage`: the helper adds
 * the operation id (returned in the handle) and the channel.
 */
export function stream<TCommand extends StreamCommand, TPage extends v.GenericSchema>(
  command: TCommand,
  args: Omit<v.InferInput<(typeof commandArgs)[TCommand]>, "opId">,
  pageSchema: TPage,
  onPage: (page: v.InferOutput<TPage>, seq: number) => void,
  opId: string = newOpId(command),
): StreamHandle {
  let ended = false;
  let resolveDone: () => void = () => {};
  let rejectDone: (error: AppError) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const finish = (error?: AppError) => {
    if (ended) return;
    ended = true;
    if (error) rejectDone(error);
    else resolveDone();
  };
  const invalid = (what: string, issues: v.BaseIssue<unknown>[]) =>
    new AppError(
      "internal",
      `Unexpected ${what} from ${command}`,
      `${issueField(issues)}: ${issues[0]?.message ?? "invalid"}`,
    );

  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    if (ended) return;
    const parsed = v.safeParse(envelope, raw);
    if (!parsed.success) {
      finish(invalid("stream message", parsed.issues));
      return;
    }
    const message = parsed.output;
    switch (message.kind) {
      case "page": {
        const page = v.safeParse(pageSchema, message.data);
        if (!page.success) {
          finish(invalid("page", page.issues));
          return;
        }
        onPage(page.output, message.seq);
        break;
      }
      case "done":
        finish();
        break;
      case "error":
        finish(new AppError(message.error.code, message.error.message, message.error.detail));
        break;
    }
  };

  let checked: Record<string, unknown>;
  try {
    checked = checkArgs(command, { ...args, opId } as v.InferInput<(typeof commandArgs)[TCommand]>);
  } catch (error) {
    finish(toAppError(error));
    return { done, opId, cancel: () => Promise.resolve() };
  }

  invoke(command, { ...checked, onPage: channel }).catch((error: unknown) => {
    finish(toAppError(error));
  });

  return {
    done,
    opId,
    cancel: async () => {
      if (ended) return;
      await invoke("cancel_operation", { opId });
    },
  };
}
