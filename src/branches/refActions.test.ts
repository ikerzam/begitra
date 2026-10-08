import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import type { Ref, Remote } from "@/ipc/schemas";
import { heldWorktreeOf, targetName, useBranchesStore } from "@/stores/branches";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useStashStore } from "@/stores/stash";
import { useToastsStore } from "@/stores/toasts";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  FAKE_TAG_OBJECT,
  fakeBackend,
  fakeCommit,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import BranchList from "@/shell/BranchList.vue";
import StashSheet from "@/stash/StashSheet.vue";

import BranchDialogs from "./BranchDialogs.vue";
import RefMenu from "./RefMenu.vue";

const remotes: Remote[] = [
  { name: "origin", fetchUrl: "https://x/o.git", pushUrl: "https://x/o.git", fetchedAt: null },
  { name: "upstream", fetchUrl: "https://x/u.git", pushUrl: "https://x/u.git", fetchedAt: null },
];

const PREFIX: Record<Ref["kind"], string> = {
  "local-branch": "refs/heads/",
  "remote-branch": "refs/remotes/",
  tag: "refs/tags/",
  stash: "refs/",
  head: "",
};

function ref(name: string, kind: Ref["kind"], extra: Partial<Ref> = {}): Ref {
  return {
    name,
    fullName: kind === "stash" ? "refs/stash" : `${PREFIX[kind]}${name}`,
    kind,
    target: fakeCommit(1).hash,
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
  target: fakeCommit(0).hash,
});
const refs: Ref[] = [
  main,
  ref("develop", "local-branch"),
  ref("origin/main", "remote-branch", { target: fakeCommit(2).hash }),
  ref("origin/develop", "remote-branch"),
  ref("origin/feature/x", "remote-branch", { target: fakeCommit(3).hash }),
  ref("gone/old", "remote-branch"),
  ref("v1.2.0", "tag", { target: fakeCommit(4).hash }),
  ref("stash@{0}", "stash", { target: fakeCommit(5).hash, message: "WIP on main" }),
];

async function open(options: FakeBackendOptions = {}): Promise<Call[]> {
  const calls = fakeBackend({ refs, remotes, ...options });
  await useRepoStore().open("/r");
  await settled();
  return calls;
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

const find = (name: string) => refs.find((entry) => entry.name === name)!;

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

describe("the actions of a ref by its kind", () => {
  it("reads the folder git names for a branch another worktree holds, apostrophes included", () => {
    const refused = (detail: string) => heldWorktreeOf({ message: "git switch failed", detail });
    expect(refused("fatal: 'apos' is already used by worktree at 'C:/x/it's here/wt'")).toBe(
      "C:/x/it's here/wt",
    );
    // git before 2.42.
    expect(refused("fatal: 'b' is already checked out at '/home/i/wt b'\n")).toBe("/home/i/wt b");
    // A translated git: not read, the error toast stays.
    expect(refused("fatal: 'b' ya está en uso por el árbol de trabajo en '/wt'")).toBeNull();
  });

  it("names a checkout's target whole, and shortens only a commit's hash", () => {
    expect(targetName({ kind: "branch", name: "feature/x" })).toBe("feature/x");
    expect(targetName({ kind: "detached", rev: "refs/tags/v1.2.0" })).toBe("v1.2.0");
    expect(targetName({ kind: "detached", rev: "refs/remotes/origin/x" })).toBe("origin/x");
    expect(targetName({ kind: "detached", rev: "a".repeat(40) })).toBe("aaaaaaa");
  });

  it("checks a remote branch out as the local branch that tracks it, or the one of its name", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    const x = { remote: "origin", branch: "feature/x" };
    expect(await branches.checkoutRemote("refs/remotes/origin/feature/x", x)).toBe(true);
    expect(of(calls, "branch_create")[0]?.args).toMatchObject({
      name: "feature/x",
      start: "refs/remotes/origin/feature/x",
      checkout: true,
      track: true,
    });
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "branches.switched",
      params: { name: "feature/x" },
    });
    // A local branch of that name exists: git's `checkout develop` switches to it.
    const develop = { remote: "origin", branch: "develop" };
    expect(await branches.checkoutRemote("refs/remotes/origin/develop", develop)).toBe(true);
    expect(of(calls, "branch_create")).toHaveLength(1);
    expect(of(calls, "switch").at(-1)?.args["target"]).toEqual({ kind: "branch", name: "develop" });
    // The current branch's own: nothing runs.
    const own = { remote: "origin", branch: "main" };
    expect(await branches.checkoutRemote("refs/remotes/origin/main", own)).toBe(false);
    expect(of(calls, "switch")).toHaveLength(1);
  });

  it("offers Stash and switch when local changes refuse the tracking checkout, then makes the branch", async () => {
    await open({
      writeErrors: {
        "/r": {
          code: "git.cli_failed",
          message: "git switch failed",
          detail: "error: Your local changes to the following files would be overwritten",
        },
      },
    });
    const branches = useBranchesStore();
    const x = { remote: "origin", branch: "feature/x" };
    expect(await branches.checkoutRemote("refs/remotes/origin/feature/x", x)).toBe(false);
    expect(branches.prompt).toMatchObject({
      kind: "dirtySwitch",
      target: { kind: "branch", name: "feature/x" },
      tracking: { fullName: "refs/remotes/origin/feature/x", remote: x },
    });
    expect(useToastsStore().toasts).toHaveLength(0);
    clearMocks();
    const clean = fakeBackend({ refs, remotes });
    const prompt = branches.prompt;
    if (prompt?.kind !== "dirtySwitch") throw new Error("no prompt");
    expect(await branches.stashAndSwitch(prompt.target, prompt.tracking)).toBe(true);
    expect(of(clean, "stash_push")).toHaveLength(1);
    expect(of(clean, "branch_create")[0]?.args).toMatchObject({ name: "feature/x", track: true });
    expect(of(clean, "switch")).toHaveLength(0);
  });

  it("deletes the upstream too once the local branch is gone, never after a refusal", async () => {
    const calls = await open({ unmergedBranch: true });
    const branches = useBranchesStore();
    const upstream = { remote: "origin", name: "main", tip: fakeCommit(2).hash };
    // Unticked, "Delete anyway" still offers the upstream, unticked.
    expect(await branches.remove("develop", false, upstream, false)).toBe(false);
    expect(branches.prompt).toMatchObject({ remote: upstream, alsoRemote: false });
    expect(await branches.remove("develop", false, upstream, true)).toBe(false);
    expect(of(calls, "push")).toHaveLength(0);
    // "Delete anyway" keeps what was asked.
    expect(branches.prompt).toMatchObject({
      kind: "delete",
      force: true,
      remote: upstream,
      alsoRemote: true,
    });
    expect(await branches.remove("develop", true, upstream, true)).toBe(true);
    await settled();
    expect(of(calls, "push")[0]?.args["request"]).toEqual({
      remote: "origin",
      branch: "main",
      tag: null,
      delete: true,
      setUpstream: false,
      forceWithLease: false,
    });
    expect(useToastsStore().toasts.map((toast) => toast.key)).toEqual([
      "branches.deleted",
      "remotes.deletedOnRemoteWas",
    ]);
    // The restoring command is behind "Show command".
    expect(useToastsStore().toasts.at(-1)?.actionKey).toBe("toast.showCommand");
  });

  it("says a delete on a remote met a branch that moved or left it since the last fetch", async () => {
    await open({
      networkErrors: {
        "/r": {
          code: "git.cli_failed",
          message: "git push failed",
          detail: " ! [rejected]        feature/x (stale info)\nerror: failed to push some refs",
        },
      },
    });
    const tip = fakeCommit(3).hash;
    const remotesStore = useRemotesStore();
    const repo = useRepoStore();
    expect(await remotesStore.deleteOnRemote({ remote: "origin", branch: "feature/x", tip })).toBe(
      false,
    );
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      kind: "error",
      key: "remotes.deleteStale",
      params: { name: "feature/x", remote: "origin" },
    });
    // Nothing was deleted: the remote branch stays.
    expect(repo.refs.some((entry) => entry.name === "origin/feature/x")).toBe(true);
  });

  it("deletes a tag, then on the remote chosen; both toasts keep what puts it back", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    expect(await branches.deleteTag("v1.2.0", "upstream")).toBe(true);
    await settled();
    expect(of(calls, "tag_delete")[0]?.args["name"]).toBe("v1.2.0");
    expect(of(calls, "push")[0]?.args["request"]).toMatchObject({
      remote: "upstream",
      branch: null,
      tag: "v1.2.0",
      delete: true,
    });
    const [local, remote] = useToastsStore().toasts;
    expect(local?.output).toBe(`git tag v1.2.0 ${FAKE_TAG_OBJECT}`);
    expect(remote?.output).toBe(`git push upstream ${FAKE_TAG_OBJECT}:refs/tags/v1.2.0`);
  });

  it("pushes a tag alone, and deletes a remote branch by its full name with its tip kept", async () => {
    const options: FakeBackendOptions = {};
    const calls = await open(options);
    const remotesStore = useRemotesStore();
    const repo = useRepoStore();
    expect(await remotesStore.pushTag("v1.2.0", "origin")).toBe(true);
    expect(of(calls, "push")[0]?.args["request"]).toEqual({
      remote: "origin",
      branch: null,
      tag: "v1.2.0",
      delete: false,
      setUpstream: false,
      forceWithLease: false,
    });
    expect(useToastsStore().toasts.at(-1)?.key).toBe("remotes.tagPushed");
    // The listing after the delete waits: the remote-tracking ref leaves at git's answer.
    options.listingGate = writeGate();
    const tip = fakeCommit(3).hash;
    expect(await remotesStore.deleteOnRemote({ remote: "origin", branch: "feature/x", tip })).toBe(
      true,
    );
    expect(of(calls, "push")[1]?.args["request"]).toMatchObject({
      remote: "origin",
      branch: "feature/x",
      delete: true,
    });
    expect(repo.refs.some((entry) => entry.name === "origin/feature/x")).toBe(false);
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "remotes.deletedOnRemoteWas",
      output: `git push origin ${tip}:refs/heads/feature/x`,
    });
  });

  it("refuses a delete on a remote while a fetch runs", async () => {
    const calls = await open({ networkDelayMs: 50 });
    const remotesStore = useRemotesStore();
    const fetching = remotesStore.fetch("origin", false);
    const tip = fakeCommit(3).hash;
    expect(await remotesStore.deleteOnRemote({ remote: "origin", branch: "feature/x", tip })).toBe(
      false,
    );
    expect(useToastsStore().toasts.at(-1)?.key).toBe("remotes.busy");
    await fetching;
    expect(of(calls, "push")).toHaveLength(0);
  });
});

describe("RefMenu", () => {
  async function menu(target: Ref) {
    const wrapper = mountWithI18n(RefMenu, {
      props: { target, x: 10, y: 10 },
      attachTo: document.body,
    });
    await settled();
    return wrapper;
  }

  const item = (wrapper: Awaited<ReturnType<typeof menu>>, id: string) =>
    wrapper.get(`[data-testid="menu-${id}"]`);

  /** `main` checked out here, `claude/fix-auth` in a linked worktree, the rest free. */
  const held: Ref[] = [
    { ...main, worktree: "/r" },
    ref("claude/fix-auth", "local-branch", { worktree: "/wt/claude-auth" }),
    ...refs.slice(1),
  ];

  it("opens the add dialog set for the branch from New worktree…, never for a tag", async () => {
    await open({ refs: held });
    const worktrees = useWorktreesStore();
    const choose = async (target: Ref) => {
      const wrapper = await menu(target);
      await item(wrapper, "new-worktree").trigger("click");
      await settled();
      wrapper.unmount();
      return worktrees.addPreset;
    };
    const named = (name: string) => held.find((entry) => entry.name === name)!;
    expect(await choose(named("develop"))).toEqual({ kind: "existing", branch: "develop" });
    // Held by a worktree, this one or another: a new branch from it.
    expect(await choose(named("main"))).toEqual({
      kind: "new",
      start: "refs/heads/main",
      name: "",
      track: false,
    });
    expect(await choose(named("claude/fix-auth"))).toEqual({
      kind: "new",
      start: "refs/heads/claude/fix-auth",
      name: "",
      track: false,
    });
    // A remote branch: a new branch of its name that tracks it, or its local branch.
    expect(await choose(named("origin/feature/x"))).toEqual({
      kind: "new",
      start: "refs/remotes/origin/feature/x",
      name: "feature/x",
      track: true,
    });
    expect(await choose(named("origin/develop"))).toEqual({ kind: "existing", branch: "develop" });
    expect(worktrees.addOpen).toBe(true);
    const tag = await menu(named("v1.2.0"));
    expect(tag.find('[data-testid="menu-new-worktree"]').exists()).toBe(false);
    tag.unmount();
    // A remote branch whose remote is no longer listed: nothing to set up from.
    const gone = await menu(named("gone/old"));
    expect(gone.find('[data-testid="menu-new-worktree"]').exists()).toBe(false);
    gone.unmount();
  });

  it("offers Open worktree on a local branch another worktree holds, and opens it", async () => {
    await open({ refs: held });
    const spy = vi.spyOn(useWorktreesStore(), "openAsContext").mockResolvedValue();
    const own = await menu(held[0]!);
    expect(own.find('[data-testid="menu-open-worktree"]').exists()).toBe(false);
    own.unmount();
    const other = await menu(held[1]!);
    expect(item(other, "open-worktree").text()).toContain("Open worktree");
    await item(other, "open-worktree").trigger("click");
    expect(spy).toHaveBeenCalledWith("/wt/claude-auth");
    other.unmount();
  });

  it("never takes the current branch for one held elsewhere, whatever spelling its folder has", async () => {
    // Opened through a junction: the listing names the real folder.
    const linked = [{ ...main, worktree: "C:/real/wt" }, ...refs.slice(1)];
    await open({ refs: linked });
    const wrapper = await menu(linked[0]!);
    expect(wrapper.find('[data-testid="menu-open-worktree"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("leads a checkout of a branch another worktree holds to that worktree, git untouched", async () => {
    const calls = await open({ refs: held });
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    expect(await branches.checkout({ kind: "branch", name: "claude/fix-auth" })).toBe(false);
    expect(of(calls, "switch")).toHaveLength(0);
    expect(branches.prompt).toEqual({
      kind: "heldElsewhere",
      branch: "claude/fix-auth",
      path: "/wt/claude-auth",
    });
    await nextTick();
    const dialog = wrapper.get('[data-testid="held-worktree-dialog"]');
    expect(dialog.text()).toContain("claude/fix-auth is checked out in another worktree");
    expect(dialog.text()).toContain("claude/fix-auth is in claude-auth.");
    expect(dialog.get('[data-testid="held-worktree-path"]').text()).toBe("/wt/claude-auth");
    const spy = vi.spyOn(useWorktreesStore(), "openAsContext").mockResolvedValue();
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    expect(spy).toHaveBeenCalledWith("/wt/claude-auth");
    expect(branches.prompt).toBeNull();
    // A remote branch whose local branch another worktree holds goes the same way.
    expect(
      await branches.checkoutRemote("refs/remotes/origin/claude/fix-auth", {
        remote: "origin",
        branch: "claude/fix-auth",
      }),
    ).toBe(false);
    expect(branches.prompt).toMatchObject({ kind: "heldElsewhere", path: "/wt/claude-auth" });
    expect(of(calls, "switch")).toHaveLength(0);
    wrapper.unmount();
  });

  it("reads git's refusal of a branch the listing did not know as held by another worktree", async () => {
    const calls = await open({
      writeErrors: {
        "/r": {
          code: "git.cli_failed",
          message: "git switch failed",
          detail: "fatal: 'develop' is already used by worktree at 'C:/wt/dev'",
        },
      },
    });
    const branches = useBranchesStore();
    expect(await branches.checkout({ kind: "branch", name: "develop" })).toBe(false);
    expect(of(calls, "switch")).toHaveLength(1);
    expect(branches.prompt).toEqual({
      kind: "heldElsewhere",
      branch: "develop",
      path: "C:/wt/dev",
    });
  });

  it("gives the stash badge its own menu, which runs on the stash the badge names", async () => {
    const calls = await open();
    const stash = find("stash@{0}");
    const wrapper = await menu(stash);
    expect(wrapper.get('[role="menu"]').attributes("aria-label")).toBe("Stash actions");
    const labels = wrapper.findAll('[role="menuitem"]').map((entry) => entry.text());
    expect(labels).toEqual(["Apply", "Pop", "Copy stash name", "Copy hash", "Drop…"]);
    expect(wrapper.find('[data-testid="menu-checkout"]').exists()).toBe(false);
    await item(wrapper, "stash-apply").trigger("click");
    await settled();
    expect(of(calls, "stash_apply")[0]?.args["stash"]).toBe(stash.target);
    wrapper.unmount();
  });

  it("drops the badge's stash through the sheet's confirmation, which takes the focus", async () => {
    const calls = await open();
    const stash = find("stash@{0}");
    const sheet = useStashStore();
    const host = mountWithI18n(
      defineComponent({ setup: () => () => (sheet.sheetOpen ? h(StashSheet) : null) }),
      { attachTo: document.body },
    );
    const wrapper = await menu(stash);
    await item(wrapper, "stash-drop").trigger("click");
    await settled();
    expect(sheet.sheetOpen).toBe(true);
    expect(sheet.dropPrompt?.hash).toBe(stash.target);
    expect(of(calls, "stash_drop")).toHaveLength(0);
    const dialog = host.get('[data-testid="stash-drop-dialog"]');
    expect(document.activeElement).toBe(dialog.get('[data-testid="dialog-cancel"]').element);
    wrapper.unmount();
    host.unmount();
  });

  it("offers a remote branch its remote's actions, none when the remote is not listed", async () => {
    await open();
    const wrapper = await menu(find("origin/feature/x"));
    expect(item(wrapper, "pull-into").text()).toContain("Pull into main…");
    expect(item(wrapper, "fetch-remote").text()).toContain("Fetch origin");
    expect(item(wrapper, "delete-on-remote").text()).toContain("Delete on origin…");
    expect(wrapper.find('[data-testid="menu-rename"]').exists()).toBe(false);
    await item(wrapper, "delete-on-remote").trigger("click");
    expect(useRemotesStore().prompt).toEqual({
      kind: "deleteOnRemote",
      remote: "origin",
      branch: "feature/x",
      tip: fakeCommit(3).hash,
    });
    wrapper.unmount();
    const gone = await menu(find("gone/old"));
    expect(gone.get('[role="menu"]').attributes("aria-label")).toBe("Remote branch actions");
    for (const id of ["pull-into", "fetch-remote", "delete-on-remote"]) {
      expect(gone.find(`[data-testid="menu-${id}"]`).exists(), id).toBe(false);
    }
    gone.unmount();
  });

  it("names a remote branch's remote from its name while the remotes load", async () => {
    await open();
    // The remotes are being listed: the menu does not wait for them.
    const remotesStore = useRemotesStore();
    remotesStore.loaded = false;
    remotesStore.loading = true;
    const wrapper = mountWithI18n(RefMenu, {
      props: { target: find("origin/feature/x"), x: 10, y: 10 },
      attachTo: document.body,
    });
    await nextTick();
    expect(item(wrapper, "fetch-remote").text()).toContain("Fetch origin");
    expect(item(wrapper, "fetch-remote").attributes("aria-disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("checks a tag out detached and says so, and asks where to push it", async () => {
    const calls = await open();
    const wrapper = await menu(find("v1.2.0"));
    expect(item(wrapper, "checkout").text()).toContain("Checkout (detached)");
    expect(wrapper.find('[data-testid="menu-merge"]').exists()).toBe(false);
    await item(wrapper, "checkout").trigger("click");
    await settled();
    expect(of(calls, "switch")[0]?.args["target"]).toEqual({
      kind: "detached",
      rev: "refs/tags/v1.2.0",
    });
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "branches.detached",
      params: { name: "v1.2.0" },
    });
    await item(wrapper, "push-tag").trigger("click");
    expect(useRemotesStore().prompt).toEqual({ kind: "pushTag", tag: "v1.2.0" });
    wrapper.unmount();
  });

  it("closes a sidebar menu before its item acts, so the dialog it opens keeps the focus", async () => {
    // Checkout of a branch another worktree holds asks in a dialog. A browser renders between
    // the item's click listener and the menu's own: the item's listener alone, then a render,
    // is what the dialog meets. The menu must be closed by then, the row focused, so the dialog
    // takes the focus and gives it back to the row; a close coming after it would take it.
    await open({ refs: held });
    const dialogs = mountWithI18n(BranchDialogs, { attachTo: document.body });
    const rows = useRepoStore()
      .refs.filter((ref) => ref.kind === "local-branch")
      .map((ref) => ({ ref, lane: 0, heldIn: null, gone: null }));
    const list = mountWithI18n(BranchList, {
      props: { rows, kind: "local", label: "Branches" },
      attachTo: document.body,
    });
    await settled();
    const row = list
      .findAll('[data-testid="list-row"]')
      .find((entry) => entry.text().startsWith("claude/fix-auth"));
    await row!.trigger("contextmenu");
    await settled();
    document
      .querySelector('[data-testid="menu-checkout"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: false }));
    await settled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const dialog = document.querySelector('[data-testid="held-worktree-dialog"]');
    expect(dialog!.contains(document.activeElement)).toBe(true);
    dialog!.querySelector<HTMLElement>('[data-testid="dialog-cancel"]')!.click();
    await settled();
    expect(document.activeElement).toBe(row!.element);
    list.unmount();
    dialogs.unmount();
  });

  it("gives the focus back to the row when its menu closes on its own", async () => {
    await open({ refs: held });
    const rows = useRepoStore()
      .refs.filter((ref) => ref.kind === "local-branch")
      .map((ref) => ({ ref, lane: 0, heldIn: null, gone: null }));
    const list = mountWithI18n(BranchList, {
      props: { rows, kind: "local", label: "Branches" },
      attachTo: document.body,
    });
    await settled();
    const row = list
      .findAll('[data-testid="list-row"]')
      .find((entry) => entry.text() === "develop");
    await row!.trigger("contextmenu");
    await settled();
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settled();
    expect(document.activeElement).toBe(row!.element);
    list.unmount();
  });

  it("runs a sidebar menu's item on Enter, never the row's checkout", async () => {
    await open();
    const rows = useRepoStore()
      .refs.filter((ref) => ref.kind === "local-branch")
      .map((ref) => ({ ref, lane: 0, heldIn: null, gone: null }));
    const list = mountWithI18n(BranchList, {
      props: { rows, kind: "local", label: "Branches" },
      attachTo: document.body,
    });
    await settled();
    const row = list
      .findAll('[data-testid="list-row"]')
      .find((entry) => entry.text() === "develop");
    await row!.trigger("contextmenu");
    await settled();
    const copy = document.querySelector<HTMLElement>('[data-testid="menu-copy-name"]');
    copy!.focus();
    copy!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settled();
    expect(list.emitted("action")).toBeUndefined();
    list.unmount();
  });

  it("copies a branch's name with a toast", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open();
    const wrapper = await menu(find("develop"));
    expect(item(wrapper, "copy-name").text()).toContain("Copy branch name");
    await item(wrapper, "copy-name").trigger("click");
    await settled();
    expect(writeText).toHaveBeenCalledWith("develop");
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "branches.nameCopied",
      params: { name: "develop" },
    });
    wrapper.unmount();
  });
});

describe("the delete dialogs", () => {
  it("offers to delete a local branch's upstream too, unticked, and deletes both once ticked", async () => {
    const calls = await open({ refs: refs.map((entry) => ({ ...entry, isCurrent: false })) });
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    const branches = useBranchesStore();
    branches.ask({
      kind: "delete",
      name: "main",
      force: false,
      output: "",
      remote: { remote: "origin", name: "main", tip: fakeCommit(2).hash },
      alsoRemote: false,
    });
    await nextTick();
    const dialog = wrapper.get('[data-testid="branch-delete-dialog"]');
    const box = dialog.get<HTMLInputElement>('[data-testid="branch-delete-remote"] input');
    expect(dialog.text()).toContain("Delete origin/main too");
    expect(box.element.checked).toBe(false);
    expect(dialog.find('[data-testid="branch-delete-remote-consequence"]').exists()).toBe(false);
    await box.setValue(true);
    expect(dialog.get('[data-testid="branch-delete-remote-consequence"]').text()).toBe(
      "main leaves origin for everyone who uses it; the toast keeps the command that puts it back.",
    );
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "branch_delete")[0]?.args["name"]).toBe("main");
    expect(of(calls, "push")[0]?.args["request"]).toMatchObject({
      remote: "origin",
      branch: "main",
      delete: true,
    });
    wrapper.unmount();
  });

  it("confirms a tag's delete, saying tags have no reflog, on the remote picked", async () => {
    const calls = await open();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    await useRemotesStore().load();
    useBranchesStore().ask({ kind: "deleteTag", name: "v1.2.0" });
    await nextTick();
    const dialog = wrapper.get('[data-testid="tag-delete-dialog"]');
    expect(dialog.text()).toContain("Delete tag v1.2.0?");
    expect(dialog.text()).toContain("Tags have no reflog");
    expect(of(calls, "tag_delete")).toHaveLength(0);
    // The current branch's remote first; the list shows once the box is ticked.
    expect(dialog.text()).toContain("Delete it on origin too");
    expect(dialog.find('[data-testid="tag-delete-remote-name"]').exists()).toBe(false);
    await dialog.get('[data-testid="tag-delete-remote"] input').setValue(true);
    expect(dialog.find('[data-testid="tag-delete-remote-name"]').exists()).toBe(true);
    expect(dialog.get('[data-testid="tag-delete-consequence"]').text()).toContain(
      "v1.2.0 leaves origin for everyone who uses it",
    );
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "tag_delete")).toHaveLength(1);
    expect(of(calls, "push")[0]?.args["request"]).toMatchObject({
      remote: "origin",
      tag: "v1.2.0",
      delete: true,
    });
    wrapper.unmount();
  });
});
