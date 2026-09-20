import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openRepository, ping } from "./commands";
import { AppError } from "./errors";
import { checkArgs, newOpId } from "./invoke";

afterEach(() => {
  clearMocks();
});

describe("checkArgs", () => {
  it("rejects a payload that does not match the Rust type, naming the field, before invoking", () => {
    const invoke = vi.fn();
    mockIPC(invoke);
    let caught: unknown;
    try {
      checkArgs("open_repository", { path: 5 as unknown as string, opId: "op-1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.code).toBe("ipc.invalid_argument");
    expect(error.message).toContain("path");
    expect(error.detail).toMatch(/^path: /);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("names nested fields with dots", () => {
    let caught: AppError | undefined;
    try {
      checkArgs("walk_commits", {
        repo: "/r",
        scope: { kind: "range", exclude: "v1", include: 3 as unknown as string },
        options: { pageSize: 500, order: "lazy" },
        maxPages: 1,
        opId: "op",
      });
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught?.detail).toMatch(/^scope\.include: /);
  });

  it("accepts a valid payload", () => {
    expect(checkArgs("ping", { message: "hi" })).toEqual({ message: "hi" });
  });

  it("refuses staging paths outside the repository and a commit without a subject", () => {
    const refused = (run: () => unknown): string | undefined => {
      try {
        run();
      } catch (error) {
        return (error as AppError).detail;
      }
      return undefined;
    };
    expect(refused(() => checkArgs("stage_paths", { repo: "/r", paths: [], opId: "op" }))).toMatch(
      /^paths: /,
    );
    for (const bad of ["../outside.txt", "/etc/passwd", "C:/x", "a/../../b"]) {
      expect(
        refused(() => checkArgs("stage_paths", { repo: "/r", paths: [bad], opId: "op" })),
        bad,
      ).toMatch(/^paths\.0: /);
    }
    expect(
      checkArgs("stage_paths", { repo: "/r", paths: ["dir with space/ünïcödé.txt"], opId: "op" }),
    ).toBeTruthy();
    expect(
      refused(() =>
        checkArgs("commit", {
          repo: "/r",
          request: { message: "  \n# comment\n", amend: false, signoff: false },
          opId: "op",
        }),
      ),
    ).toMatch(/^request\.message: /);
    expect(
      refused(() =>
        checkArgs("apply_selection", {
          repo: "/r",
          target: "stage",
          selection: {
            path: "a.txt",
            status: "modified",
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [{ kind: "added", text: "x", noNewline: false, selected: false }],
              },
            ],
          },
          opId: "op",
        }),
      ),
    ).toMatch(/^selection: /);
  });
});

describe("call", () => {
  it("invokes the command and validates the result", async () => {
    mockIPC((cmd, args) => {
      expect(cmd).toBe("ping");
      return { message: (args as { message: string }).message, backend: "git2", version: "0.1.0" };
    });
    await expect(ping("hello")).resolves.toEqual({
      message: "hello",
      backend: "git2",
      version: "0.1.0",
    });
  });

  it("fails with internal when the result has an unexpected shape", async () => {
    mockIPC(() => ({ message: "x", backend: 7 }));
    const error = await ping("x").catch((e: unknown) => e as AppError);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("internal");
    expect((error as AppError).detail).toMatch(/^backend: /);
  });

  it("converts a rejected invoke into an AppError", async () => {
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Tauri rejects with the serialised AppError object
      throw { code: "repo.not_found", message: "No Git repository found at or above /x" };
    });
    const error = await openRepository("/x").catch((e: unknown) => e as AppError);
    expect((error as AppError).code).toBe("repo.not_found");
  });

  it("rejects an invalid argument without calling the backend", async () => {
    const invoke = vi.fn();
    mockIPC(invoke);
    const error = await openRepository("").catch((e: unknown) => e as AppError);
    expect((error as AppError).code).toBe("ipc.invalid_argument");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("newOpId", () => {
  it("is unique and prefixed", () => {
    const a = newOpId("walk");
    const b = newOpId("walk");
    expect(a).not.toBe(b);
    expect(a.startsWith("walk-")).toBe(true);
  });
});
