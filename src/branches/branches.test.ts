import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import type { Conflict } from "@/ipc/schemas";
import { useBranchesStore } from "@/stores/branches";
import { useChangesStore } from "@/stores/changes";
import { useRepoStore } from "@/stores/repo";
import { useSequencerStore } from "@/stores/sequencer";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import BranchDialogs from "./BranchDialogs.vue";
import { validName } from "./names";
import OperationBanner from "./OperationBanner.vue";

const conflicts: Conflict[] = [
  { path: "src/a.ts", kind: "both-modified" },
  { path: "docs/b.md", kind: "deleted-by-them" },
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
  const calls = fakeBackend(options);
  await useRepoStore().open("/r");
  await settled();
  return calls;
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

const input = (wrapper: ReturnType<typeof mountWithI18n>, id: string) =>
  wrapper.get<HTMLInputElement>(`input[data-testid="${id}"]`);

describe("branch names", () => {
  it("accepts what git accepts and refuses the rest", () => {
    for (const good of ["main", "feature/tile-cache", "v2.3.1", "ünïcödé"]) {
      expect(validName(good), good).toBe(true);
    }
    for (const bad of ["", "-x", "a b", "a..b", "a~1", "a/", ".hidden", "a.lock", "a\\b"]) {
      expect(validName(bad), bad).toBe(false);
    }
  });
});

describe("BranchDialogs", () => {
  it("creates a branch from the dialog once the name is valid, checking it out by default", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    branches.ask({ kind: "create", start: "main", startLabel: "main" });
    await nextTick();
    const dialog = wrapper.get('[data-testid="branch-create-dialog"]');
    expect(dialog.text()).toContain("From main.");
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("disabled")).toBeDefined();
    await input(wrapper, "branch-name").setValue("bad name");
    await nextTick();
    expect(dialog.text()).toContain("Not a valid branch name.");
    await input(wrapper, "branch-name").setValue("feature/x");
    await nextTick();
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("disabled")).toBeUndefined();
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "branch_create")[0]?.args).toMatchObject({
      name: "feature/x",
      start: "main",
      checkout: true,
    });
    expect(branches.prompt).toBeNull();
    wrapper.unmount();
  });

  it("resets with the chosen mode, destructive for hard", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    branches.ask({ kind: "reset", rev: "a".repeat(40), label: "aaaaaaa", branch: "main" });
    await nextTick();
    const dialog = wrapper.get('[data-testid="reset-dialog"]');
    expect(dialog.text()).toContain("Reset main to aaaaaaa?");
    expect(dialog.text()).toContain("The reflog keeps the previous HEAD for 90 days");
    expect(dialog.get('[data-testid="dialog-confirm"]').text()).toBe("Reset mixed");
    await dialog.get('[data-testid="radio-hard"] input').setValue(true);
    await nextTick();
    expect(dialog.get('[data-testid="dialog-confirm"]').text()).toBe("Reset hard");
    expect(dialog.get('[data-testid="dialog-confirm"]').attributes("data-variant")).toBe(
      "destructive",
    );
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "reset")[0]?.args).toMatchObject({ rev: "a".repeat(40), mode: "hard" });
    wrapper.unmount();
  });

  it("offers Delete anyway with git's refusal and the reflog note", async () => {
    const calls = await open({ unmergedBranch: true });
    const branches = useBranchesStore();
    const wrapper = mountWithI18n(BranchDialogs, { attachTo: document.body });
    branches.ask({ kind: "delete", name: "develop", force: false, output: "" });
    await nextTick();
    expect(wrapper.get('[data-testid="branch-delete-dialog"]').text()).toContain("Delete develop?");
    await wrapper.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    await nextTick();
    const anyway = wrapper.get('[data-testid="branch-delete-dialog"]');
    expect(anyway.text()).toContain("Delete develop anyway?");
    expect(anyway.text()).toContain("reflog for 90 days");
    expect(anyway.text()).toContain("not fully merged");
    await anyway.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "branch_delete").map((call) => call.args["force"])).toEqual([false, true]);
    wrapper.unmount();
  });
});

describe("OperationBanner", () => {
  it("names the merge and its conflicts, disables Continue until resolved, aborts once confirmed", async () => {
    const calls = await open({
      operation: "merge",
      conflicts,
      commitContext: {
        operation: "merge",
        preparedMessage: "Merge branch 'develop'\n\n# Conflicts:",
      },
    });
    const sequencer = useSequencerStore();
    await sequencer.load();
    await useChangesStore().loadContext();
    const wrapper = mountWithI18n(OperationBanner, { attachTo: document.body });
    await flushPromises();
    const banner = wrapper.get('[data-testid="operation-banner"]');
    expect(banner.get('[data-testid="operation-title"]').text()).toBe(
      "Merging develop into main · 2 conflicts",
    );
    expect(banner.get('[data-testid="operation-hint"]').text()).toBe(
      "Resolve the files, mark them, then continue.",
    );
    expect(banner.get('[data-testid="operation-continue"]').attributes("disabled")).toBeDefined();
    expect(banner.find('[data-testid="operation-skip"]').exists()).toBe(false);
    // From the graph, "Resolve…" opens the changes screen.
    await banner.get('[data-testid="operation-resolve"]').trigger("click");
    await flushPromises();
    expect(useShellStore().layoutMode).toBe("changes");
    await banner.get('[data-testid="operation-abort"]').trigger("click");
    await nextTick();
    const dialog = wrapper.get('[data-testid="abort-dialog"]');
    expect(dialog.text()).toContain("Abort the merge?");
    expect(dialog.text()).toContain("The operation's changes are dropped");
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "sequencer")[0]?.args["action"]).toBe("abort");
    wrapper.unmount();
  });

  it("continues once every conflict is marked, and shows Skip for a rebase", async () => {
    const calls = await open({ operation: "rebase", conflicts: [] });
    const sequencer = useSequencerStore();
    await sequencer.load();
    const wrapper = mountWithI18n(OperationBanner, { attachTo: document.body });
    await flushPromises();
    const banner = wrapper.get('[data-testid="operation-banner"]');
    expect(banner.get('[data-testid="operation-title"]').text()).toBe("Rebasing main");
    expect(banner.get('[data-testid="operation-hint"]').text()).toContain("continue or abort");
    expect(banner.find('[data-testid="operation-skip"]').exists()).toBe(true);
    expect(banner.get('[data-testid="operation-continue"]').attributes("disabled")).toBeUndefined();
    await banner.get('[data-testid="operation-continue"]').trigger("click");
    await settled();
    expect(of(calls, "sequencer")[0]?.args["action"]).toBe("continue");
    wrapper.unmount();
  });
});
