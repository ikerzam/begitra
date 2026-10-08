import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import RefMenu from "@/branches/RefMenu.vue";
import FileMenu from "@/detail/FileMenu.vue";
import CommitContextMenu from "@/graph/CommitContextMenu.vue";
import type { Ref, Remote } from "@/ipc/schemas";
import LineMenu from "@/review/LineMenu.vue";
import { detectPlatform } from "@/shortcuts/platform";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import type { WorktreeRow } from "@/stores/worktrees";
import { fakeBackend, fakeCommit, settled, type Call } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";
import WorktreeContextMenu from "@/worktrees/WorktreeContextMenu.vue";

const HASH = fakeCommit(0).hash;
/** The platform's words for Reveal, as the menus show them. */
const REVEAL = {
  windows: "Reveal in Explorer",
  macos: "Reveal in Finder",
  linux: "Open containing folder",
}[detectPlatform()];

const origin: Remote = {
  name: "origin",
  fetchUrl: "git@github.com:geo/portal.git",
  pushUrl: "git@github.com:geo/portal.git",
  fetchedAt: null,
};

function ref(name: string, kind: Ref["kind"], extra: Partial<Ref> = {}): Ref {
  const prefix = {
    "local-branch": "refs/heads/",
    "remote-branch": "refs/remotes/",
    tag: "refs/tags/",
  };
  return {
    name,
    fullName: `${prefix[kind as keyof typeof prefix] ?? ""}${name}`,
    kind,
    target: HASH,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
    committedAt: null,
    ...extra,
  };
}

const main = ref("main", "local-branch", {
  isCurrent: true,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  worktree: "/r",
});
const refs = [main, ref("draft", "local-branch"), ref("origin/main", "remote-branch")];

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

async function open(remotes: Remote[] = [origin]): Promise<Call[]> {
  const calls = fakeBackend({ refs, remotes });
  await useRepoStore().open("/r");
  await settled();
  return calls;
}

const labels = (wrapper: ReturnType<typeof mountWithI18n>) =>
  wrapper.findAll('[role="menuitem"]').map((item) => item.text());

const lastCall = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd).at(-1);

describe("the menus' links", () => {
  it("puts Copy link with the copies and Open on GitHub with the opens in a commit's menu", async () => {
    const calls = await open();
    const wrapper = mountWithI18n(CommitContextMenu, {
      props: { x: 0, y: 0, hash: HASH },
      attachTo: document.body,
    });
    await settled();
    expect(labels(wrapper)).toEqual([
      expect.stringContaining("Copy hash"),
      "Copy message",
      "Copy link",
      "Diff from here",
      "Compare with…",
      "Select as range end",
      "Create branch here…",
      "Tag…",
      "Cherry-pick",
      "Revert",
      "Reset HEAD to here…",
      "Open on GitHub",
      "Open in terminal",
      "Open in editor",
    ]);
    await wrapper.get('[data-testid="menu-open-link"]').trigger("click");
    await settled();
    expect(lastCall(calls, "open_link")?.args).toEqual({
      url: `https://github.com/geo/portal/commit/${HASH}`,
    });
    wrapper.unmount();
  });

  it("offers neither item for a remote on a host it does not know", async () => {
    await open([{ ...origin, fetchUrl: "ssh://git@git.company.com:2222/geo/portal.git" }]);
    const wrapper = mountWithI18n(CommitContextMenu, { props: { x: 0, y: 0, hash: HASH } });
    await settled();
    expect(wrapper.find('[data-testid="menu-open-link"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="menu-copy-link"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("links a branch by its upstream after its name's copy, none never pushed", async () => {
    const calls = await open();
    const wrapper = mountWithI18n(RefMenu, { props: { target: main, x: 0, y: 0 } });
    await settled();
    expect(labels(wrapper).slice(-4)).toEqual([
      "Copy branch name",
      "Copy link",
      "Open on GitHub",
      "Delete…",
    ]);
    await wrapper.get('[data-testid="menu-open-link"]').trigger("click");
    await settled();
    expect(lastCall(calls, "open_link")?.args).toEqual({
      url: "https://github.com/geo/portal/tree/main",
    });
    wrapper.unmount();
    const draft = mountWithI18n(RefMenu, { props: { target: refs[1]!, x: 0, y: 0 } });
    await settled();
    expect(draft.find('[data-testid="menu-copy-link"]').exists()).toBe(false);
    draft.unmount();
  });

  it("links a commit's file at the commit and reveals a working file", async () => {
    const calls = await open();
    const atCommit = mountWithI18n(FileMenu, {
      props: {
        file: changedFile("src/tiles.ts"),
        x: 0,
        y: 0,
        source: { kind: "commit", hash: HASH },
      },
    });
    await settled();
    expect(labels(atCommit)).toEqual([
      "Copy path",
      "Copy link",
      "Open on GitHub",
      "Open in editor",
      "File history",
    ]);
    await atCommit.get('[data-testid="menu-open-link"]').trigger("click");
    await settled();
    expect(lastCall(calls, "open_link")?.args).toEqual({
      url: `https://github.com/geo/portal/blob/${HASH}/src/tiles.ts`,
    });
    atCommit.unmount();
    // A file its commit deleted has no page there.
    const deleted = mountWithI18n(FileMenu, {
      props: {
        file: changedFile("src/old.ts", { status: "deleted" }),
        x: 0,
        y: 0,
        source: { kind: "commit", hash: HASH },
      },
    });
    expect(deleted.find('[data-testid="menu-copy-link"]').exists()).toBe(false);
    deleted.unmount();
    const working = mountWithI18n(FileMenu, {
      props: {
        file: changedFile("src/tiles.ts"),
        x: 0,
        y: 0,
        side: "worktree",
        source: { kind: "working", root: "/r" },
      },
    });
    await settled();
    expect(labels(working)).toContain(REVEAL);
    await working.get('[data-testid="menu-reveal"]').trigger("click");
    await settled();
    expect(lastCall(calls, "reveal_path")?.args).toEqual({ root: "/r", path: "/r/src/tiles.ts" });
    await working.get('[data-testid="menu-open-link"]').trigger("click");
    await settled();
    expect(lastCall(calls, "open_link")?.args).toEqual({
      url: "https://github.com/geo/portal/blob/main/src/tiles.ts",
    });
    working.unmount();
  });

  it("opens a line's page from the line menu", async () => {
    const calls = await open();
    const link = {
      url: `https://github.com/geo/portal/blob/${HASH}/a.ts?plain=1#L42`,
      forge: "GitHub",
    };
    const wrapper = mountWithI18n(LineMenu, {
      props: { x: 0, y: 0, path: "a.ts", line: 42, selection: "", history: true, link },
      attachTo: document.body,
    });
    const items = [...document.querySelectorAll('[data-testid="line-menu"] [role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Copy path",
      "Copy link",
      "Open in editor at line 42",
      "Open on GitHub",
      "File history",
    ]);
    document.querySelector<HTMLElement>('[data-testid="menu-open-link"]')!.click();
    await settled();
    expect(lastCall(calls, "open_link")?.args).toEqual({ url: link.url });
    wrapper.unmount();
  });

  it("reveals a worktree's folder from its menu", async () => {
    const calls = await open();
    const row: WorktreeRow = {
      path: "/wt/claude-auth",
      name: "claude-auth",
      branch: "claude/fix-auth",
      head: HASH,
      detached: false,
      isMain: false,
      locked: false,
      lockReason: null,
      prunable: false,
      bare: false,
      dirty: false,
      lastCommitAt: null,
      lastSubject: null,
      ahead: null,
      behind: null,
    };
    const wrapper = mountWithI18n(WorktreeContextMenu, { props: { row, x: 0, y: 0 } });
    await wrapper.get('[data-testid="menu-reveal"]').trigger("click");
    await settled();
    expect(lastCall(calls, "reveal_path")?.args).toEqual({ root: "/r", path: "/wt/claude-auth" });
    wrapper.unmount();
  });
});
