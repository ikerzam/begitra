import { describe, expect, it } from "vitest";

import { undoPlan, type UndoPlanInput } from "./undoPlan";

const HEAD = "a".repeat(40);
const PARENT = "b".repeat(40);

const context: NonNullable<UndoPlanInput["context"]> = {
  head: HEAD,
  headParents: [PARENT],
  unborn: false,
  operation: "none",
  otherOperation: null,
};

const base: UndoPlanInput = {
  context,
  shownHead: HEAD,
  conflicts: false,
  branch: { upstream: "origin/main", ahead: 1 },
  remotes: [{ name: "origin" }],
};

const plan = (over: Partial<UndoPlanInput>) => undoPlan({ ...base, ...over });
const refusal = (over: Partial<UndoPlanInput>) => {
  const result = plan(over);
  return result.kind === "refused" ? result.reason : result.kind;
};
const withContext = (over: Partial<NonNullable<UndoPlanInput["context"]>>) =>
  refusal({ context: { ...context, ...over } });

describe("undoPlan", () => {
  it("moves HEAD to its parent when the upstream does not hold the commit", () => {
    const undo = { kind: "undo", hash: HEAD, parent: PARENT, pushed: false, remote: null };
    expect(plan({})).toEqual(undo);
    expect(plan({ branch: { upstream: null, ahead: null } })).toEqual(undo);
    // A detached HEAD has no branch: the undo moves HEAD alone.
    expect(plan({ branch: null })).toEqual(undo);
  });

  it("asks first when a remote's tracking branch holds the commit", () => {
    expect(plan({ branch: { upstream: "origin/main", ahead: 0 } })).toEqual({
      kind: "undo",
      hash: HEAD,
      parent: PARENT,
      pushed: true,
      remote: "origin",
    });
    // A remote whose name holds a slash.
    expect(
      plan({
        branch: { upstream: "team/eu/main", ahead: 0 },
        remotes: [{ name: "team" }, { name: "team/eu" }],
      }),
    ).toMatchObject({ pushed: true, remote: "team/eu" });
  });

  it("does not ask for a local upstream, which no remote holds", () => {
    // `branch.main.remote=.` with `feature/x`: "feature" is not a remote.
    expect(plan({ branch: { upstream: "feature/x", ahead: 0 } })).toMatchObject({
      pushed: false,
      remote: null,
    });
  });

  it("asks when the remotes could not be read and the upstream reads as a remote's", () => {
    expect(plan({ branch: { upstream: "origin/main", ahead: 0 }, remotes: null })).toMatchObject({
      pushed: true,
      remote: "origin",
    });
  });

  it("refuses what moving HEAD to the parent cannot undo, with the reason", () => {
    expect(refusal({ context: null })).toBe("unknown");
    expect(withContext({ unborn: true, head: null, headParents: [] })).toBe("unborn");
    expect(withContext({ headParents: [] })).toBe("root");
    expect(withContext({ headParents: [PARENT, "c".repeat(40)] })).toBe("merge");
  });

  it("refuses while an operation or conflicts hold HEAD, naming the operation", () => {
    expect(withContext({ operation: "merge" })).toBe("merging");
    expect(withContext({ operation: "rebase" })).toBe("rebasing");
    expect(withContext({ operation: "cherry-pick" })).toBe("cherry-picking");
    expect(withContext({ operation: "revert" })).toBe("reverting");
    expect(withContext({ otherOperation: "bisect" })).toBe("bisect");
    expect(withContext({ otherOperation: "am" })).toBe("am");
    expect(withContext({ otherOperation: "sequence" })).toBe("sequence");
    expect(refusal({ conflicts: true })).toBe("conflicts");
  });

  it("refuses while the refs shown name another commit than the one read", () => {
    expect(refusal({ shownHead: "d".repeat(40) })).toBe("moving");
    expect(refusal({ shownHead: null })).toBe("moving");
  });
});
