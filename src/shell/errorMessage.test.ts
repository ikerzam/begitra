import { describe, expect, it } from "vitest";

import { errorText } from "./errorMessage";

describe("errorText", () => {
  it("maps codes to their sentences and falls back to the generic one", () => {
    expect(errorText({ code: "repo.not_found", message: "gone" }, "/r")).toEqual({
      key: "errors.repoNotFound",
      params: { path: "/r", message: "gone" },
    });
    expect(errorText({ code: "git.not_started", message: "no git" }).key).toBe(
      "errors.gitNotStarted",
    );
    expect(errorText({ code: "index.database", message: "x" }).key).toBe("errors.indexDatabase");
    expect(errorText({ code: "something.else", message: "x" }).key).toBe("errors.generic");
  });

  it("names the index lock when git could not take it", () => {
    const locked = {
      code: "git.cli_failed",
      message: "git add failed",
      detail: "fatal: Unable to create '/r/.git/index.lock': File exists.",
    };
    expect(errorText(locked).key).toBe("errors.indexLock");
    expect(
      errorText({ code: "git.cli_failed", message: "git add failed", detail: "fatal: other" }).key,
    ).toBe("errors.gitFailed");
    expect(errorText({ code: "git.cli_failed", message: "git add failed" }).key).toBe(
      "errors.gitFailed",
    );
  });
});
