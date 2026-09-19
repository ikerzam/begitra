import { describe, expect, it } from "vitest";

import { AppError, toAppError } from "./errors";

describe("AppError", () => {
  it("keeps code, message and detail", () => {
    const error = new AppError("repo.not_found", "No repository", "raw");
    expect(error.code).toBe("repo.not_found");
    expect(error.message).toBe("No repository");
    expect(error.detail).toBe("raw");
    expect(error.is("repo.not_found", "repo.invalid")).toBe(true);
    expect(error.is("op.cancelled")).toBe(false);
    expect(error.toJSON()).toEqual({
      code: "repo.not_found",
      message: "No repository",
      detail: "raw",
    });
    expect(new AppError("internal", "x").toJSON()).toEqual({ code: "internal", message: "x" });
  });
});

describe("toAppError", () => {
  it("parses a serialised backend error", () => {
    const error = toAppError({
      code: "git.cli_failed",
      message: "git status failed",
      detail: "fatal",
    });
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("git.cli_failed");
    expect(error.detail).toBe("fatal");
  });

  it("maps Tauri's invalid args message to ipc.invalid_argument naming the field", () => {
    const error = toAppError(
      "invalid args `path` for command `open_repository`: invalid type: integer `5`, expected a string",
    );
    expect(error.code).toBe("ipc.invalid_argument");
    expect(error.message).toContain("path");
    expect(error.detail).toContain("expected a string");
  });

  it("wraps other strings, errors and values as internal", () => {
    expect(toAppError("boom").code).toBe("internal");
    expect(toAppError(new Error("bad")).message).toBe("bad");
    const unknown = toAppError({ weird: true });
    expect(unknown.code).toBe("internal");
    expect(unknown.detail).toBe('{"weird":true}');
  });

  it("passes AppError through", () => {
    const original = new AppError("op.cancelled", "Cancelled");
    expect(toAppError(original)).toBe(original);
  });
});
