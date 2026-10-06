import { describe, expect, it } from "vitest";

import { pushPlan, type PushPlanInput } from "./pushPlan";

const base: PushPlanInput = {
  branch: { name: "main", upstream: "origin/main", ahead: 1 },
  remotes: ["origin"],
  amend: false,
  openRepository: true,
};

const plan = (over: Partial<PushPlanInput>) => pushPlan({ ...base, ...over });

describe("pushPlan", () => {
  it("pushes the branch to its upstream's remote", () => {
    expect(plan({})).toEqual({ kind: "push", remote: "origin", branch: "main", publish: false });
    expect(
      plan({ branch: { name: "feat/geo-241", upstream: "upstream/feat/geo-241", ahead: 3 } }),
    ).toEqual({ kind: "push", remote: "upstream", branch: "feat/geo-241", publish: false });
  });

  it("publishes a branch without upstream to the only remote", () => {
    expect(plan({ branch: { name: "claude/fix-auth", upstream: null, ahead: null } })).toEqual({
      kind: "push",
      remote: "origin",
      branch: "claude/fix-auth",
      publish: true,
    });
  });

  it("leaves the remote to the push dialog when there are several and no upstream", () => {
    expect(
      plan({
        branch: { name: "claude/fix-auth", upstream: null, ahead: null },
        remotes: ["origin", "upstream"],
      }),
    ).toEqual({ kind: "dialog", branch: "claude/fix-auth" });
  });

  it("refuses before the commit, with the reason", () => {
    const refusal = (over: Partial<PushPlanInput>) => {
      const result = plan(over);
      return result.kind === "refused" ? result.reason : result.kind;
    };
    expect(refusal({ branch: null })).toBe("detached");
    expect(refusal({ branch: { name: "main", upstream: null, ahead: null }, remotes: [] })).toBe(
      "noRemote",
    );
    expect(refusal({ branch: { name: "main", upstream: null, ahead: null }, remotes: null })).toBe(
      "readingRemotes",
    );
    expect(refusal({ branch: { name: "main", upstream: "origin/trunk", ahead: 1 } })).toBe(
      "renamedUpstream",
    );
    expect(
      refusal({ amend: true, branch: { name: "main", upstream: "origin/main", ahead: 0 } }),
    ).toBe("amendPushed");
    expect(refusal({ openRepository: false })).toBe("otherRepository");
  });

  it("lets an amend push while the commit it replaces is not on the upstream, or when nobody knows", () => {
    expect(
      plan({ amend: true, branch: { name: "main", upstream: "origin/main", ahead: 2 } }).kind,
    ).toBe("push");
    expect(
      plan({ amend: true, branch: { name: "main", upstream: "origin/main", ahead: null } }).kind,
    ).toBe("push");
    expect(plan({ amend: true, branch: { name: "new", upstream: null, ahead: null } }).kind).toBe(
      "push",
    );
  });
});
