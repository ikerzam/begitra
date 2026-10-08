import { describe, expect, it } from "vitest";

import { commitOfRevision, forgeOf, linkTo, remoteFor, type Forge } from "./forgeLinks";

const HASH = "c07be21a9f3e4b5d6c7b8a9f0e1d2c3b4a596877";

describe("forgeOf", () => {
  it("reads GitHub in each URL form", () => {
    const github = { kind: "github", base: "https://github.com/geo/portal" };
    for (const url of [
      "git@github.com:geo/portal.git",
      "git@github.com:geo/portal",
      "github.com:geo/portal.git",
      "https://github.com/geo/portal.git",
      "https://github.com/geo/portal",
      "https://github.com/geo/portal/",
      "https://iker@github.com/geo/portal.git",
      "https://x-access-token:secret@github.com/geo/portal.git",
      "http://github.com/geo/portal.git",
      "HTTPS://GitHub.com/geo/portal.git",
      "ssh://git@github.com/geo/portal.git",
      "ssh://git@ssh.github.com:443/geo/portal.git",
      "git://github.com/geo/portal.git",
      "  git@github.com:geo/portal.git\n",
    ]) {
      expect(forgeOf(url), url).toEqual(github);
    }
  });

  it("keeps GitLab's nested groups", () => {
    expect(forgeOf("https://gitlab.com/geo/maps/portal.git")).toEqual({
      kind: "gitlab",
      base: "https://gitlab.com/geo/maps/portal",
    });
    expect(forgeOf("git@gitlab.com:geo/maps/tiles/portal.git")).toEqual({
      kind: "gitlab",
      base: "https://gitlab.com/geo/maps/tiles/portal",
    });
    expect(forgeOf("ssh://git@altssh.gitlab.com:443/geo/portal.git")).toEqual({
      kind: "gitlab",
      base: "https://gitlab.com/geo/portal",
    });
  });

  it("reads Bitbucket, Codeberg and gitea.com", () => {
    expect(forgeOf("git@bitbucket.org:geo/portal.git")).toEqual({
      kind: "bitbucket",
      base: "https://bitbucket.org/geo/portal",
    });
    expect(forgeOf("https://iker@bitbucket.org/geo/portal.git")).toEqual({
      kind: "bitbucket",
      base: "https://bitbucket.org/geo/portal",
    });
    expect(forgeOf("https://codeberg.org/geo/portal.git")).toEqual({
      kind: "codeberg",
      base: "https://codeberg.org/geo/portal",
    });
    expect(forgeOf("git@gitea.com:geo/portal.git")).toEqual({
      kind: "gitea",
      base: "https://gitea.com/geo/portal",
    });
  });

  it("reads Azure DevOps over HTTPS and SSH, its older hosts included", () => {
    const azure = { kind: "azure", base: "https://dev.azure.com/geo/maps/_git/portal" };
    expect(forgeOf("https://dev.azure.com/geo/maps/_git/portal")).toEqual(azure);
    expect(forgeOf("https://geo@dev.azure.com/geo/maps/_git/portal")).toEqual(azure);
    expect(forgeOf("git@ssh.dev.azure.com:v3/geo/maps/portal")).toEqual(azure);
    expect(forgeOf("ssh://git@ssh.dev.azure.com/v3/geo/maps/portal")).toEqual(azure);
    expect(forgeOf("https://dev.azure.com/geo/_git/portal")).toEqual({
      kind: "azure",
      base: "https://dev.azure.com/geo/_git/portal",
    });
    expect(forgeOf("https://geo.visualstudio.com/maps/_git/portal")).toEqual({
      kind: "azure",
      base: "https://geo.visualstudio.com/maps/_git/portal",
    });
    expect(forgeOf("https://geo.visualstudio.com/DefaultCollection/maps/_git/portal")).toEqual({
      kind: "azure",
      base: "https://geo.visualstudio.com/DefaultCollection/maps/_git/portal",
    });
    expect(forgeOf("geo@vs-ssh.visualstudio.com:v3/geo/maps/portal")).toEqual({
      kind: "azure",
      base: "https://geo.visualstudio.com/maps/_git/portal",
    });
  });

  it("spells names with spaces and unicode once encoded", () => {
    expect(forgeOf("https://dev.azure.com/geo/Map%20Tiles/_git/portal%20web")).toEqual({
      kind: "azure",
      base: "https://dev.azure.com/geo/Map%20Tiles/_git/portal%20web",
    });
    expect(forgeOf("git@ssh.dev.azure.com:v3/geo/Map Tiles/portal")).toEqual({
      kind: "azure",
      base: "https://dev.azure.com/geo/Map%20Tiles/_git/portal",
    });
    expect(forgeOf("https://gitlab.com/geo/m%C3%A1pas.git")).toEqual({
      kind: "gitlab",
      base: "https://gitlab.com/geo/m%C3%A1pas",
    });
  });

  it("knows no other host, path or protocol", () => {
    for (const url of [
      "ssh://git@git.company.com:2222/geo/portal.git",
      "https://github.example.com/geo/portal.git",
      "https://evilgithub.com/geo/portal.git",
      "https://github.com.evil.com/geo/portal.git",
      "https://github.com:8443/geo/portal.git",
      "https://github.com/geo",
      "https://github.com/geo/portal/tree/main",
      "https://bitbucket.org/geo/maps/portal.git",
      "https://dev.azure.com/geo/maps/portal",
      "https://dev.azure.com/_git/portal",
      "https://maps.geo.visualstudio.com/_git/portal",
      "git@ssh.dev.azure.com:v2/geo/maps/portal",
      "geo@vs-ssh.visualstudio.com:v3/ge.o/maps/portal",
      "https://gitlab.com/geo/portal/-/tree/main",
      "file:///home/iker/code/portal",
      "/home/iker/code/portal",
      "C:\\Code\\portal",
      "C:/Code/portal",
      "../portal",
      "ftp://github.com/geo/portal.git",
      "",
    ]) {
      expect(forgeOf(url), url).toBeNull();
    }
  });
});

describe("linkTo", () => {
  const github: Forge = { kind: "github", base: "https://github.com/geo/portal" };
  const gitlab: Forge = { kind: "gitlab", base: "https://gitlab.com/geo/maps/portal" };
  const bitbucket: Forge = { kind: "bitbucket", base: "https://bitbucket.org/geo/portal" };
  const azure: Forge = { kind: "azure", base: "https://dev.azure.com/geo/maps/_git/portal" };
  const codeberg: Forge = { kind: "codeberg", base: "https://codeberg.org/geo/portal" };
  const gitea: Forge = { kind: "gitea", base: "https://gitea.com/geo/portal" };

  it("links a commit by its full hash", () => {
    const commit = { kind: "commit", hash: HASH } as const;
    expect(linkTo(github, commit)).toBe(`https://github.com/geo/portal/commit/${HASH}`);
    expect(linkTo(gitlab, commit)).toBe(`https://gitlab.com/geo/maps/portal/-/commit/${HASH}`);
    expect(linkTo(bitbucket, commit)).toBe(`https://bitbucket.org/geo/portal/commits/${HASH}`);
    expect(linkTo(azure, commit)).toBe(`https://dev.azure.com/geo/maps/_git/portal/commit/${HASH}`);
    expect(linkTo(codeberg, commit)).toBe(`https://codeberg.org/geo/portal/commit/${HASH}`);
    expect(linkTo(gitea, commit)).toBe(`https://gitea.com/geo/portal/commit/${HASH}`);
  });

  it("links a branch by its name on the remote, a segment at a time", () => {
    const branch = { kind: "branch", name: "claude/fix-auth" } as const;
    expect(linkTo(github, branch)).toBe("https://github.com/geo/portal/tree/claude/fix-auth");
    expect(linkTo(gitlab, branch)).toBe(
      "https://gitlab.com/geo/maps/portal/-/tree/claude/fix-auth",
    );
    expect(linkTo(bitbucket, branch)).toBe(
      "https://bitbucket.org/geo/portal/branch/claude/fix-auth",
    );
    expect(linkTo(azure, branch)).toBe(
      "https://dev.azure.com/geo/maps/_git/portal?version=GBclaude%2Ffix-auth",
    );
    expect(linkTo(codeberg, branch)).toBe(
      "https://codeberg.org/geo/portal/src/branch/claude/fix-auth",
    );
    expect(linkTo(github, { kind: "branch", name: "fix/#42 ñandú?" })).toBe(
      "https://github.com/geo/portal/tree/fix/%2342%20%C3%B1and%C3%BA%3F",
    );
  });

  it("links a tag", () => {
    const tag = { kind: "tag", name: "v2.4.0" } as const;
    expect(linkTo(github, tag)).toBe("https://github.com/geo/portal/tree/v2.4.0");
    expect(linkTo(gitlab, tag)).toBe("https://gitlab.com/geo/maps/portal/-/tree/v2.4.0");
    expect(linkTo(bitbucket, tag)).toBe("https://bitbucket.org/geo/portal/src/v2.4.0");
    expect(linkTo(azure, tag)).toBe("https://dev.azure.com/geo/maps/_git/portal?version=GTv2.4.0");
    expect(linkTo(gitea, tag)).toBe("https://gitea.com/geo/portal/src/tag/v2.4.0");
  });

  it("links a file at a commit, at a line", () => {
    const at = { kind: "commit", hash: HASH } as const;
    const file = { kind: "file", path: "src/tiles.ts", at, line: 42 } as const;
    expect(linkTo(github, file)).toBe(
      `https://github.com/geo/portal/blob/${HASH}/src/tiles.ts?plain=1#L42`,
    );
    expect(linkTo(gitlab, file)).toBe(
      `https://gitlab.com/geo/maps/portal/-/blob/${HASH}/src/tiles.ts?plain=1#L42`,
    );
    expect(linkTo(bitbucket, file)).toBe(
      `https://bitbucket.org/geo/portal/src/${HASH}/src/tiles.ts#lines-42`,
    );
    expect(linkTo(azure, file)).toBe(
      `https://dev.azure.com/geo/maps/_git/portal?path=/src/tiles.ts&version=GC${HASH}` +
        "&line=42&lineEnd=43&lineStartColumn=1&lineEndColumn=1&lineStyle=plain&_a=contents",
    );
    expect(linkTo(codeberg, file)).toBe(
      `https://codeberg.org/geo/portal/src/commit/${HASH}/src/tiles.ts?display=source#L42`,
    );
  });

  it("links a file on a branch, without a line", () => {
    const at = { kind: "branch", name: "claude/fix-auth" } as const;
    const file = { kind: "file", path: "docs/Map notes.md", at, line: null } as const;
    expect(linkTo(github, file)).toBe(
      "https://github.com/geo/portal/blob/claude/fix-auth/docs/Map%20notes.md",
    );
    expect(linkTo(gitlab, file)).toBe(
      "https://gitlab.com/geo/maps/portal/-/blob/claude/fix-auth/docs/Map%20notes.md",
    );
    expect(linkTo(bitbucket, file)).toBe(
      "https://bitbucket.org/geo/portal/src/claude/fix-auth/docs/Map%20notes.md",
    );
    expect(linkTo(azure, file)).toBe(
      "https://dev.azure.com/geo/maps/_git/portal?path=/docs/Map%20notes.md" +
        "&version=GBclaude%2Ffix-auth&_a=contents",
    );
    expect(linkTo(gitea, file)).toBe(
      "https://gitea.com/geo/portal/src/branch/claude/fix-auth/docs/Map%20notes.md",
    );
  });
});

describe("remoteFor", () => {
  const origin = { name: "origin", fetchUrl: "git@github.com:geo/portal.git" };
  const fork = { name: "fork", fetchUrl: "git@github.com:iker/portal.git" };
  const team = { name: "team/eu", fetchUrl: "git@gitlab.com:geo/portal.git" };

  it("takes the upstream's remote, the longest name winning", () => {
    expect(remoteFor("fork/claude/fix-auth", [origin, fork])).toBe(fork);
    expect(remoteFor("team/eu/main", [origin, team])).toBe(team);
  });

  it("falls back to origin, then to the only remote", () => {
    expect(remoteFor(null, [fork, origin])).toBe(origin);
    expect(remoteFor("gone/main", [fork, origin])).toBe(origin);
    expect(remoteFor(null, [fork])).toBe(fork);
    expect(remoteFor(null, [fork, team])).toBeNull();
    expect(remoteFor(null, [])).toBeNull();
  });
});

describe("commitOfRevision", () => {
  const refs = [
    { kind: "head", name: "HEAD", fullName: "HEAD", target: HASH },
    {
      kind: "local-branch",
      name: "main",
      fullName: "refs/heads/main",
      target: "1".repeat(40),
    },
    {
      kind: "remote-branch",
      name: "origin/main",
      fullName: "refs/remotes/origin/main",
      target: "2".repeat(40),
    },
  ] as const;

  it("reads a full hash, HEAD and the refs listed", () => {
    expect(commitOfRevision(HASH.toUpperCase(), refs)).toBe(HASH);
    expect(commitOfRevision("HEAD", refs)).toBe(HASH);
    expect(commitOfRevision("refs/heads/main", refs)).toBe("1".repeat(40));
    expect(commitOfRevision("main", refs)).toBe("1".repeat(40));
    expect(commitOfRevision("origin/main", refs)).toBe("2".repeat(40));
  });

  it("reads a short name as git does: a tag before a branch", () => {
    const both = [
      { kind: "local-branch", name: "v2", fullName: "refs/heads/v2", target: "1".repeat(40) },
      { kind: "tag", name: "v2", fullName: "refs/tags/v2", target: "3".repeat(40) },
    ] as const;
    expect(commitOfRevision("v2", both)).toBe("3".repeat(40));
  });

  it("knows no short hash or unlisted name", () => {
    expect(commitOfRevision("c07be21", refs)).toBeNull();
    expect(commitOfRevision("feature", refs)).toBeNull();
    expect(commitOfRevision("HEAD", [])).toBeNull();
  });
});
