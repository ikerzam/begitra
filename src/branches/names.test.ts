import { describe, expect, it } from "vitest";

import { remoteOf } from "./names";

const remote = (name: string) => ({ kind: "remote-branch", name });

describe("remoteOf", () => {
  it("takes the listed remote that prefixes the name, the longest winning", () => {
    const remotes = [{ name: "origin" }, { name: "origin/team" }, { name: "fork" }];
    expect(remoteOf(remote("origin/main"), remotes)).toEqual({ remote: "origin", branch: "main" });
    expect(remoteOf(remote("origin/team/x"), remotes)).toEqual({
      remote: "origin/team",
      branch: "x",
    });
    expect(remoteOf(remote("fork/feature/y"), remotes)).toEqual({
      remote: "fork",
      branch: "feature/y",
    });
  });

  it("knows no remote for another kind of ref, or for a remote no longer listed", () => {
    expect(
      remoteOf({ kind: "local-branch", name: "origin/main" }, [{ name: "origin" }]),
    ).toBeNull();
    expect(remoteOf(remote("gone/main"), [{ name: "origin" }])).toBeNull();
    // A remote named like the start of another is no prefix without its slash.
    expect(remoteOf(remote("originals/main"), [{ name: "origin" }])).toBeNull();
  });
});
