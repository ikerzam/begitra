// The samples are git 2.54's own output (Git for Windows, LC_ALL=C), captured from the commands
// named beside each, and OpenSSH's through git.

import { describe, expect, it } from "vitest";

import { toAppError, type AppError } from "@/ipc/errors";

import { classifyFailure } from "./failures";

const cli = (detail: string): AppError =>
  toAppError({ code: "git.cli_failed", message: "git failed", detail });

describe("sorting a member's failure", () => {
  it.each([
    [
      "sign-in",
      // git ls-remote https://github.com/… with no credential helper and no prompts
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ],
    [
      "sign-in",
      // Git Credential Manager under GCM_INTERACTIVE=never
      "fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://dev.azure.com': terminal prompts disabled",
    ],
    [
      "sign-in",
      // OpenSSH with the failing askpass and an unknown host key
      "INFO: Could not find files for the given pattern(s).\nHost key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    ],
    [
      "sign-in",
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    ],
    [
      "sign-in",
      "fatal: unable to access 'https://gitlab.example.com/x.git/': The requested URL returned error: 403",
    ],
    [
      "rejected",
      // git push after someone else pushed
      "To C:/Users/iker/origin.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'C:/Users/iker/origin.git'\nhint: Updates were rejected because the remote contains work that you do not",
    ],
    [
      "diverged",
      // git merge --ff-only FETCH_HEAD on a diverged branch
      "hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nfatal: Not possible to fast-forward, aborting.",
    ],
    [
      "local-changes",
      "error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md\nPlease commit your changes or stash them before you merge.\nAborting",
    ],
    ["branch-exists", "fatal: a branch named 'release/2.4' already exists"],
    [
      "network",
      "fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid",
    ],
    [
      "network",
      "ssh: Could not resolve hostname example.invalid: Name or service not known\nfatal: Could not read from remote repository.",
    ],
    [
      "network",
      "fatal: unable to access 'https://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9 after 2090 ms: Could not connect to server",
    ],
  ])("reads %s from git's words", (reason, detail) => {
    expect(classifyFailure(cli(detail)).reason).toBe(reason);
  });

  it("names an upstream that left the remote by the engine's code", () => {
    const failure = classifyFailure(
      toAppError({
        code: "refs.not_found",
        message: "ref refs/heads/develop on the remote was not found",
      }),
    );
    expect(failure.reason).toBe("upstream-gone");
  });

  it("keeps git's first line of what went wrong otherwise, and the whole output", () => {
    const detail =
      "From C:/Users/iker/origin.git\n * branch            main       -> FETCH_HEAD\nfatal: refusing to merge unrelated histories";
    const failure = classifyFailure(cli(detail));
    expect(failure).toEqual({
      reason: "other",
      message: "fatal: refusing to merge unrelated histories",
      output: detail,
    });
    expect(
      classifyFailure(toAppError({ code: "op.timeout", message: "pull took longer than 600 s" })),
    ).toEqual({
      reason: "other",
      message: "pull took longer than 600 s",
      output: "pull took longer than 600 s",
    });
  });
});
