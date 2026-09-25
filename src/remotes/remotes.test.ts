import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import type { Ref, Remote } from "@/ipc/schemas";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import {
  fakeBackend,
  fakeCommit,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { mountWithI18n } from "@/test/mount";
import { chooseOption, shownLabel } from "@/test/select";

import NetworkDialog from "./NetworkDialog.vue";
import RemotesSheet from "./RemotesSheet.vue";

const remotes: Remote[] = [
  {
    name: "origin",
    fetchUrl: "git@github.com:ikerzam/geoportal.git",
    fetchedAt: 1_758_499_000,
    pushUrl: "git@github.com:ikerzam/geoportal.git",
  },
  {
    name: "upstream",
    fetchUrl: "https://iker:ghp_secret@example.com/geoportal.git",
    fetchedAt: null,
    pushUrl: "https://example.com/geoportal.git",
  },
];

const ref = (over: Partial<Ref>): Ref => ({
  name: "main",
  fullName: "refs/heads/main",
  kind: "local-branch",
  target: fakeCommit(0).hash,
  isCurrent: true,
  upstream: "origin/main",
  ahead: 2,
  behind: 0,
  worktree: "/r",
  message: null,
  ...over,
});
const refs: Ref[] = [
  ref({}),
  ref({
    name: "origin/main",
    fullName: "refs/remotes/origin/main",
    kind: "remote-branch",
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
  }),
  ref({
    name: "origin/develop",
    fullName: "refs/remotes/origin/develop",
    kind: "remote-branch",
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
  }),
];

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

async function open(options: FakeBackendOptions = {}): Promise<Call[]> {
  const calls = fakeBackend({ remotes, refs, ...options });
  await useRepoStore().open("/r");
  await settled();
  return calls;
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

describe("RemotesSheet", () => {
  it("lists the remotes with their URLs, fetches one with prune, adds and removes", async () => {
    const calls = await open();
    const store = useRemotesStore();
    await store.openSheet();
    const wrapper = mountWithI18n(RemotesSheet, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="sheet-count"]').text()).toBe("2");
    const rows = wrapper.findAll('[data-testid="remotes-list"] [role="row"]');
    expect(rows.map((row) => row.get('[data-testid="remote-row-name"]').text())).toEqual([
      "origin",
      "upstream",
    ]);
    expect(rows[0]?.get('[data-testid="remote-row-url"]').text()).toBe(
      "git@github.com:ikerzam/geoportal.git",
    );
    // FETCH_HEAD's time dates the remote it named; the other one was never fetched.
    expect(rows[0]?.get('[data-testid="remote-row-fetched"]').text()).toMatch(/^fetched /);
    expect(rows[1]?.get('[data-testid="remote-row-fetched"]').text()).toBe("never fetched");
    // Credentials in a URL never show.
    expect(rows[1]?.get('[data-testid="remote-row-url"]').text()).toBe(
      "https://***@example.com/geoportal.git",
    );
    await rows[1]!.get('[data-testid="remote-fetch-prune"]').trigger("click");
    await settled();
    expect(of(calls, "fetch")[0]?.args).toMatchObject({ remote: "upstream", prune: true });
    // Add a remote from the inline form.
    await wrapper.get('[data-testid="remotes-add"]').trigger("click");
    await nextTick();
    await wrapper.get('input[data-testid="remote-name"]').setValue("fork");
    await wrapper
      .get('input[data-testid="remote-url"]')
      .setValue("git@github.com:ane/geoportal.git");
    await nextTick();
    await wrapper.get('[data-testid="remote-add-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "remote_add")[0]?.args).toMatchObject({ name: "fork" });
    expect(wrapper.findAll('[data-testid="remotes-list"] [role="row"]')).toHaveLength(3);
    // Remove confirms once.
    await wrapper.findAll('[data-testid="remote-remove"]')[2]!.trigger("click");
    await nextTick();
    const dialog = wrapper.get('[data-testid="remote-remove-dialog"]');
    expect(dialog.text()).toContain("Remove fork?");
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "remote_remove")[0]?.args["name"]).toBe("fork");
    expect(wrapper.text()).toContain("Fetch updates the remote branches");
    wrapper.unmount();
  });

  it("shows the empty sentence without remotes and closes on Escape", async () => {
    await open({ remotes: [] });
    const store = useRemotesStore();
    await store.openSheet();
    const wrapper = mountWithI18n(RemotesSheet, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="remotes-empty"]').text()).toContain("No remotes.");
    await wrapper.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
    expect(store.sheetOpen).toBe(false);
    wrapper.unmount();
  });
});

describe("NetworkDialog", () => {
  it("pushes the branch to its upstream's remote with the options ticked", async () => {
    const calls = await open();
    const store = useRemotesStore();
    await store.load();
    store.ask({ kind: "push", branch: "main" });
    const wrapper = mountWithI18n(NetworkDialog, {
      props: { mode: "push", branch: "main" },
      attachTo: document.body,
    });
    await flushPromises();
    const dialog = wrapper.get('[data-testid="push-dialog"]');
    expect(dialog.text()).toContain("Push main");
    expect(dialog.text()).toContain("2 commits ahead of origin/main.");
    expect(shownLabel(dialog.get('[data-testid="network-remote"]'))).toBe("origin");
    expect(dialog.text()).toContain("Set upstream (origin/main already is)");
    await dialog.get('[data-testid="network-force"] input').setValue(true);
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "push")[0]?.args["request"]).toEqual({
      remote: "origin",
      branch: "main",
      setUpstream: false,
      forceWithLease: true,
    });
    wrapper.unmount();
  });

  it("pulls with rebase from the chosen remote branch", async () => {
    const calls = await open();
    const store = useRemotesStore();
    await store.load();
    store.ask({ kind: "pull", branch: "main" });
    const wrapper = mountWithI18n(NetworkDialog, {
      props: { mode: "pull", branch: "main" },
      attachTo: document.body,
    });
    await flushPromises();
    const dialog = wrapper.get('[data-testid="pull-dialog"]');
    expect(dialog.text()).toContain("Pull main");
    await chooseOption(dialog.get('[data-testid="network-branch"]'), "develop");
    await dialog.get('[data-testid="network-rebase"] input').setValue(true);
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "pull")[0]?.args["request"]).toEqual({
      remote: "origin",
      branch: "develop",
      rebase: true,
    });
    wrapper.unmount();
  });
});
