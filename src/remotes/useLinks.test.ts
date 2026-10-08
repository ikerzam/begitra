import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";

import type { Ref, Remote } from "@/ipc/schemas";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useToastsStore } from "@/stores/toasts";
import {
  fakeBackend,
  fakeCommit,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import { useLinks } from "./useLinks";

const HASH = fakeCommit(0).hash;

const remote = (name: string, url: string): Remote => ({
  name,
  fetchUrl: url,
  pushUrl: url,
  fetchedAt: null,
});

const ref = (over: Partial<Ref>): Ref => ({
  name: "main",
  fullName: "refs/heads/main",
  kind: "local-branch",
  target: HASH,
  isCurrent: true,
  upstream: "origin/claude/fix-auth",
  ahead: 0,
  behind: 0,
  worktree: "/r",
  message: null,
  committedAt: null,
  ...over,
});

const refs: Ref[] = [
  ref({}),
  ref({ name: "draft", fullName: "refs/heads/draft", isCurrent: false, upstream: null }),
  ref({
    name: "stale",
    fullName: "refs/heads/stale",
    isCurrent: false,
    upstream: "origin/stale",
    ahead: null,
    behind: null,
  }),
  ref({
    name: "origin/claude/fix-auth",
    fullName: "refs/remotes/origin/claude/fix-auth",
    kind: "remote-branch",
    isCurrent: false,
    upstream: null,
    worktree: null,
  }),
  ref({
    name: "v2.4.0",
    fullName: "refs/tags/v2.4.0",
    kind: "tag",
    isCurrent: false,
    upstream: null,
    worktree: null,
  }),
];

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

/** The composable, with `/r` open on a backend holding `origin` at `url`. */
async function withLinks(url: string, options: FakeBackendOptions = {}) {
  const calls = fakeBackend({ refs, remotes: [remote("origin", url)], ...options });
  await useRepoStore().open("/r");
  await settled();
  let made!: ReturnType<typeof useLinks>;
  const host = mountWithI18n(
    defineComponent({
      setup() {
        made = useLinks();
        return () => null;
      },
    }),
  );
  made.ensureRemotes();
  await settled();
  return { links: made, calls, host };
}

function sent(calls: Call[], cmd: string): Record<string, unknown> | undefined {
  return calls.filter((call) => call.cmd === cmd).at(-1)?.args;
}

const byName = (name: string) => refs.find((entry) => entry.name === name)!;

describe("useLinks", () => {
  it("links a commit, a branch by its upstream, a remote branch and a tag", async () => {
    const { links } = await withLinks("https://gitlab.com/geo/maps/portal.git");
    expect(links.linkOf({ kind: "commit", hash: HASH })).toEqual({
      url: `https://gitlab.com/geo/maps/portal/-/commit/${HASH}`,
      forge: "GitLab",
    });
    expect(links.linkOf({ kind: "ref", ref: byName("main") })?.url).toBe(
      "https://gitlab.com/geo/maps/portal/-/tree/claude/fix-auth",
    );
    expect(links.linkOf({ kind: "ref", ref: byName("origin/claude/fix-auth") })?.url).toBe(
      "https://gitlab.com/geo/maps/portal/-/tree/claude/fix-auth",
    );
    expect(links.linkOf({ kind: "ref", ref: byName("v2.4.0") })?.url).toBe(
      "https://gitlab.com/geo/maps/portal/-/tree/v2.4.0",
    );
    // A branch never pushed, and one whose upstream is gone, have no page.
    expect(links.linkOf({ kind: "ref", ref: byName("draft") })).toBeNull();
    expect(links.linkOf({ kind: "ref", ref: byName("stale") })).toBeNull();
  });

  it("links a commit's file at its line and a working file at the upstream without one", async () => {
    const { links } = await withLinks("git@github.com:geo/portal.git");
    const commit = { kind: "commit", hash: HASH } as const;
    expect(links.fileLink(changedFile("src/tiles.ts"), commit, 42)?.url).toBe(
      `https://github.com/geo/portal/blob/${HASH}/src/tiles.ts?plain=1#L42`,
    );
    const working = { kind: "working", root: "/r" } as const;
    expect(links.fileLink(changedFile("src/tiles.ts"), working, 42)?.url).toBe(
      "https://github.com/geo/portal/blob/claude/fix-auth/src/tiles.ts",
    );
    expect(links.fileLink(changedFile("src/new.ts", { status: "added" }), working)).toBeNull();
    // Asked for a line, a working file's link still names none: the upstream's lines differ.
    expect(links.linkOf({ kind: "file", path: "src/tiles.ts", commit: null, line: 42 })?.url).toBe(
      "https://github.com/geo/portal/blob/claude/fix-auth/src/tiles.ts",
    );
    // Another repository's working tree: its remotes are not the open one's.
    expect(links.fileLink(changedFile("src/tiles.ts"), { kind: "working", root: "/other" })).toBe(
      null,
    );
  });

  it("offers nothing for a remote on a host it does not know", async () => {
    const { links } = await withLinks("ssh://git@git.company.com:2222/geo/portal.git");
    expect(links.linkOf({ kind: "commit", hash: HASH })).toBeNull();
    expect(links.linkOf({ kind: "ref", ref: byName("main") })).toBeNull();
    expect(links.fileLink(changedFile("a.ts"), { kind: "working", root: "/r" })).toBeNull();
  });

  it("opens and copies a link, with a toast for each outcome", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { links, calls } = await withLinks("git@github.com:geo/portal.git");
    const link = links.linkOf({ kind: "commit", hash: HASH })!;
    await links.open(link);
    expect(sent(calls, "open_link")).toEqual({
      url: `https://github.com/geo/portal/commit/${HASH}`,
    });
    await links.copy(link);
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(link.url);
    expect(useToastsStore().toasts.at(-1)?.message).toBe("Link copied");
  });

  it("reveals a path, and says so when it is gone or the platform refuses", async () => {
    const { links, calls } = await withLinks("git@github.com:geo/portal.git", {
      missingPaths: ["/r/src/gone.ts"],
    });
    await links.reveal("/r", "/r/src/tiles.ts", "src/tiles.ts");
    expect(sent(calls, "reveal_path")).toEqual({ root: "/r", path: "/r/src/tiles.ts" });
    expect(useToastsStore().toasts).toHaveLength(0);
    await links.reveal("/r", "/r/src/gone.ts", "src/gone.ts");
    expect(useToastsStore().toasts.at(-1)?.message).toBe("src/gone.ts is not on disk.");
  });

  it("asks for the remotes quietly: a menu that cannot list them offers no link and no toast", async () => {
    const { links, calls } = await withLinks("git@github.com:geo/portal.git", {
      failRemotes: true,
    });
    links.ensureRemotes();
    await settled();
    expect(calls.filter((call) => call.cmd === "remotes").length).toBeGreaterThan(0);
    expect(links.linkOf({ kind: "commit", hash: HASH })).toBeNull();
    expect(useToastsStore().toasts).toHaveLength(0);
  });

  it("says a refused link or path is one Begitra does not open", async () => {
    const { links } = await withLinks("git@github.com:geo/portal.git", { refuseOpener: true });
    await links.open({ url: "file:///C:/Windows", forge: "GitHub" });
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      kind: "error",
      message:
        "Begitra opens only the pages of the code hosts it knows and the files of your repositories.",
    });
    expect(useToastsStore().toasts.at(-1)?.output).toBeUndefined();
    await links.reveal("/r", "C:/Windows");
    expect(useToastsStore().toasts).toHaveLength(2);
    expect(useToastsStore().toasts.at(-1)?.output).toBeUndefined();
  });

  it("puts the platform's refusal in the toast's output", async () => {
    const { links } = await withLinks("git@github.com:geo/portal.git", { failOpener: true });
    await links.open({ url: "https://github.com/geo/portal", forge: "GitHub" });
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      kind: "error",
      message: "Couldn't open the browser.",
      output: "no handler for https",
    });
    await links.reveal("/r", "/r");
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      message: "Couldn't open the file manager.",
      output: "no handler for https",
    });
  });
});
