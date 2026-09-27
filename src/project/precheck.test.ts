import { describe, expect, it } from "vitest";

import { toAppError } from "@/ipc/errors";
import type { OverviewRow } from "@/stores/overview";

import { precheck } from "./precheck";

function row(name: string, over: Partial<OverviewRow> = {}): OverviewRow {
  return {
    path: `/code/${name}`,
    name,
    missing: false,
    worktree: false,
    mainPath: null,
    branch: "main",
    detached: false,
    upstream: { name: "origin/main", remote: "origin", branch: "main", pushRemote: "origin" },
    ahead: 0,
    behind: 0,
    dirty: false,
    changed: 0,
    operation: "none",
    lastCommitAt: null,
    lastCommitSubject: null,
    fetchedAt: null,
    error: null,
    ...over,
  };
}

const reasons = (plan: ReturnType<typeof precheck>) =>
  Object.fromEntries(plan.skipped.map((item) => [item.name, item.reason]));
const acting = (plan: ReturnType<typeof precheck>) => plan.acting.map((item) => item.name);

describe("the check before a bulk operation", () => {
  it("fetches every member that is there and can be read", () => {
    const plan = precheck("fetch", [
      row("api"),
      row("gone", { missing: true }),
      row("broken", { error: toAppError({ code: "repo.invalid", message: "bad" }) }),
      row("rebasing", { operation: "rebase", detached: true, upstream: null }),
    ]);
    expect(acting(plan)).toEqual(["api", "rebasing"]);
    expect(reasons(plan)).toEqual({ gone: "missing", broken: "unread" });
  });

  it("pulls a branch with an upstream, and skips a detached HEAD, none and an operation", () => {
    const plan = precheck("pull", [
      row("api", { behind: 2 }),
      row("web", { dirty: true, changed: 3 }),
      row("detached", { detached: true, branch: null }),
      row("solo", { upstream: null }),
      row("infra", { operation: "rebase" }),
    ]);
    expect(acting(plan)).toEqual(["api", "web"]);
    expect(reasons(plan)).toEqual({
      detached: "detached",
      solo: "no-upstream",
      infra: "operation",
    });
    expect(plan.skipped.find((item) => item.name === "infra")?.operation).toBe("rebase");
    expect(plan.acting[0]).toMatchObject({ branch: "main", upstream: "origin/main", behind: 2 });
  });

  it("pushes only a branch ahead of an upstream of its own name on the remote it pushes to", () => {
    const plan = precheck("push", [
      row("api", { ahead: 2 }),
      row("web", { ahead: 0 }),
      row("infra", { upstream: null }),
      row("renamed", {
        ahead: 1,
        branch: "fix",
        upstream: { name: "origin/main", remote: "origin", branch: "main", pushRemote: "origin" },
      }),
      row("local", {
        ahead: 1,
        upstream: { name: "main", remote: ".", branch: "main", pushRemote: "." },
      }),
      row("fork", {
        ahead: 1,
        upstream: { name: "origin/main", remote: "origin", branch: "main", pushRemote: "mine" },
      }),
    ]);
    expect(acting(plan)).toEqual(["api"]);
    expect(reasons(plan)).toEqual({
      web: "nothing-to-push",
      infra: "no-upstream",
      renamed: "other-name",
      local: "local-upstream",
      fork: "push-remote",
    });
    expect(plan.skipped.find((item) => item.name === "fork")?.remote).toBe("mine");
  });

  it("switches the clean ones not on the branch yet", () => {
    const plan = precheck(
      "switch",
      [
        row("api"),
        row("web", { dirty: true }),
        row("counted", { dirty: false, changed: 2 }),
        row("there", { branch: "release/2.4" }),
        row("detached", { detached: true, branch: null }),
      ],
      "release/2.4",
    );
    expect(acting(plan)).toEqual(["api", "detached"]);
    expect(reasons(plan)).toEqual({
      web: "uncommitted",
      counted: "uncommitted",
      there: "same-branch",
    });
    expect(plan.branch).toBe("release/2.4");
  });

  it("creates a branch wherever no operation is in progress", () => {
    const plan = precheck(
      "create",
      [row("api", { dirty: true }), row("infra", { operation: "merge" })],
      "feat/x",
    );
    expect(acting(plan)).toEqual(["api"]);
    expect(reasons(plan)).toEqual({ infra: "operation" });
  });
});
