import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import type { Ref } from "@/ipc/schemas";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useStashStore } from "@/stores/stash";
import { useToastsStore } from "@/stores/toasts";
import {
  fakeBackend,
  fakeCommit,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import StashSheet from "./StashSheet.vue";

function stashRef(index: number, message: string, hash: string): Ref {
  return {
    name: `stash@{${index}}`,
    fullName: "refs/stash",
    kind: "stash",
    target: hash,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message,
  };
}

const refs: Ref[] = [
  {
    name: "main",
    fullName: "refs/heads/main",
    kind: "local-branch",
    target: fakeCommit(0).hash,
    isCurrent: true,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: "/r",
    message: null,
  },
  stashRef(0, "wip: worker pool before the rebase", fakeCommit(3).hash),
  stashRef(1, "On main: tiles spike", "f".repeat(40)),
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
  const calls = fakeBackend({ refs, ...options });
  await useRepoStore().open("/r");
  await settled();
  return calls;
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

describe("StashSheet", () => {
  it("lists the stashes with their messages, pushes with a message and untracked, pops and drops", async () => {
    const calls = await open();
    const stash = useStashStore();
    stash.openSheet();
    const wrapper = mountWithI18n(StashSheet, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="sheet-count"]').text()).toBe("2");
    const rows = wrapper.findAll('[data-testid="stash-list"] [role="row"]');
    expect(rows.map((row) => row.get('[data-testid="stash-row-message"]').text())).toEqual([
      "wip: worker pool before the rebase",
      "On main: tiles spike",
    ]);
    expect(rows[0]?.text()).toContain("stash@{0}");
    expect(rows[0]?.find('[data-testid="stash-row-date"]').exists()).toBe(true);
    expect(rows[1]?.find('[data-testid="stash-row-date"]').exists()).toBe(false);
    // Opening the sheet loads the changes lists so the button counts them.
    expect(wrapper.get('[data-testid="stash-push"]').text()).toBe("Stash 8 changes");
    await wrapper.get('input[data-testid="stash-message"]').setValue("wip");
    await wrapper.get('[data-testid="stash-untracked"] input').setValue(true);
    await wrapper.get('[data-testid="stash-push"]').trigger("submit");
    await settled();
    expect(of(calls, "stash_push")[0]?.args["request"]).toEqual({
      message: "wip",
      includeUntracked: true,
      paths: [],
    });
    await rows[1]!.get('[data-testid="stash-pop"]').trigger("click");
    await settled();
    expect(of(calls, "stash_pop")[0]?.args["index"]).toBe(1);
    await rows[0]!.get('[data-testid="stash-drop"]').trigger("click");
    await nextTick();
    const dialog = wrapper.get('[data-testid="stash-drop-dialog"]');
    expect(dialog.text()).toContain("Drop stash@{0}?");
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "stash_drop")[0]?.args["index"]).toBe(0);
    // The way back stays in the toast: the dropped stash's hash and the command.
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.key).toBe("stash.dropped");
    expect(toast?.params).toEqual({ hash: fakeCommit(3).hash.slice(0, 7) });
    expect(toast?.output).toBe(`git stash apply ${fakeCommit(3).hash}`);
    expect(wrapper.text()).toContain("Apply keeps the stash; pop drops it once applied.");
    wrapper.unmount();
  });

  it("shows the empty sentence and the plain Stash button without changes", async () => {
    await open({ refs: [refs[0]!], changes: { unstaged: [], staged: [] } });
    const stash = useStashStore();
    stash.openSheet();
    const wrapper = mountWithI18n(StashSheet, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="stash-empty"]').text()).toContain("No stashes.");
    expect(wrapper.get('[data-testid="stash-push"]').text()).toBe("Stash");
    await wrapper.get('[data-testid="sheet-close"]').trigger("click");
    expect(stash.sheetOpen).toBe(false);
    wrapper.unmount();
  });
});
