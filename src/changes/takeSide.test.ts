// A conflicted file taken whole from one side on the changes screen: from the conflict's menu
// and from the unmerged card, asked once in the banner's dialog, with "Undo" in the toast.

import { clearMocks } from "@tauri-apps/api/mocks";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import OperationBanner from "@/branches/OperationBanner.vue";
import type { Conflict } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts } from "@/shortcuts/useShortcut";
import { useRepoStore } from "@/stores/repo";
import { useSequencerStore } from "@/stores/sequencer";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useToastsStore } from "@/stores/toasts";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import ChangesLayout from "./ChangesLayout.vue";

const conflicts: Conflict[] = [
  { path: "docs/b.md", kind: "deleted-by-them" },
  { path: "src/a.ts", kind: "both-modified" },
];

/** A conflicted file as the status lists it: unmerged, without hunks. */
const unmerged = (path: string) =>
  changedFile(path, { status: "unmerged", additions: 0, deletions: 0, hunks: [] });

const Screen = defineComponent({
  render: () => h("div", [h(OperationBanner), h(ChangesLayout)]),
});

let uninstall: () => void = () => {};

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
  setShortcutRegistry(new ShortcutRegistry("windows"));
  uninstall = installShortcuts(window);
});

afterEach(() => {
  uninstall();
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

async function mountScreen(options: FakeBackendOptions = {}) {
  const calls = fakeBackend({
    operation: "merge",
    conflicts,
    changes: { unstaged: [unmerged("docs/b.md"), unmerged("src/a.ts")], staged: [] },
    ...options,
  });
  await useRepoStore().open("/r");
  await settled();
  await useSequencerStore().load();
  const wrapper = mountWithI18n(Screen, { attachTo: document.body });
  await settled();
  return { wrapper, calls };
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

const conflictRow = (wrapper: VueWrapper, path: string) =>
  wrapper.get(`[data-list="conflicts"][data-path="${path}"]`);

const listed = () => useSequencerStore().conflicts.map((conflict) => conflict.path);

describe("taking a side", () => {
  it("takes the side picked from the conflict's menu once confirmed, and Undo brings it back", async () => {
    const { wrapper, calls } = await mountScreen();
    await conflictRow(wrapper, "src/a.ts").trigger("contextmenu");
    await nextTick();
    expect(wrapper.get('[data-testid="menu-take-ours"]').text()).toBe("Use main's version");
    expect(wrapper.get('[data-testid="menu-take-theirs"]').text()).toBe("Use develop's version");
    await wrapper.get('[data-testid="menu-take-theirs"]').trigger("click");
    await nextTick();
    const dialog = wrapper.get('[data-testid="take-side-dialog"]');
    expect(dialog.text()).toContain("Use develop's version of a.ts?");
    expect(dialog.text()).toContain(
      "main's changes to src/a.ts, and any edit made to it since the conflict, go, and the file is marked resolved. Undo in the toast brings the conflict back.",
    );
    expect(dialog.get('[data-testid="dialog-confirm"]').text()).toBe("Use develop's version");
    expect(of(calls, "take_side")).toHaveLength(0);
    await dialog.get('[data-testid="dialog-confirm"]').trigger("click");
    await settled();
    expect(of(calls, "take_side")[0]?.args).toMatchObject({ paths: ["src/a.ts"], side: "theirs" });
    expect(wrapper.find('[data-testid="take-side-dialog"]').exists()).toBe(false);
    expect(listed()).toEqual(["docs/b.md"]);
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.key).toBe("sequencer.side.used.ref");
    toast?.onAction?.();
    await settled();
    expect(of(calls, "restore_conflicts")[0]?.args["paths"]).toEqual(["src/a.ts"]);
    expect(listed()).toEqual(["docs/b.md", "src/a.ts"]);
    wrapper.unmount();
  });

  it("offers both sides on the unmerged card, and a cancel writes nothing", async () => {
    const { wrapper, calls } = await mountScreen();
    await conflictRow(wrapper, "src/a.ts").trigger("click");
    await settled();
    const card = wrapper.get('[data-testid="diff-guard"]');
    expect(card.text()).toContain("use one side's version whole");
    expect(card.get('[data-testid="diff-guard-take-ours"]').text()).toBe("Use main's version");
    expect(card.get('[data-testid="diff-guard-take-theirs"]').text()).toBe("Use develop's version");
    await card.get('[data-testid="diff-guard-take-ours"]').trigger("click");
    await nextTick();
    const dialog = wrapper.get('[data-testid="take-side-dialog"]');
    expect(dialog.text()).toContain("Use main's version of a.ts?");
    expect(dialog.text()).toContain("develop's changes to src/a.ts");
    await dialog.get('[data-testid="dialog-cancel"]').trigger("click");
    await nextTick();
    expect(wrapper.find('[data-testid="take-side-dialog"]').exists()).toBe(false);
    expect(of(calls, "take_side")).toHaveLength(0);
    expect(listed()).toEqual(["docs/b.md", "src/a.ts"]);
    // While a sequencer write runs, the sides wait.
    useSequencerStore().busy = true;
    await nextTick();
    for (const side of ["ours", "theirs"]) {
      expect(
        card.get(`[data-testid="diff-guard-take-${side}"]`).attributes("disabled"),
        side,
      ).toBeDefined();
    }
    wrapper.unmount();
  });

  it("says the file goes where the side taken deleted it", async () => {
    const { wrapper } = await mountScreen();
    await conflictRow(wrapper, "docs/b.md").trigger("contextmenu");
    await nextTick();
    await wrapper.get('[data-testid="menu-take-theirs"]').trigger("click");
    await nextTick();
    expect(wrapper.get('[data-testid="take-side-dialog"]').text()).toContain(
      "main's changes to docs/b.md, and any edit made to it since the conflict, go: the file is deleted, as develop has no version of it, and marked resolved.",
    );
    wrapper.unmount();
  });

  it("names commits by their short hash and a revert's side as the state before its commit", async () => {
    const hash = "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4";
    const { wrapper } = await mountScreen({
      operation: "revert",
      sides: {
        ours: { kind: "ref", name: "main" },
        theirs: { kind: "before", hash, subject: "Drop the legacy tile server" },
      },
    });
    await conflictRow(wrapper, "src/a.ts").trigger("contextmenu");
    await nextTick();
    expect(wrapper.get('[data-testid="menu-take-theirs"]').text()).toBe(
      "Use the version before a1b2c3d",
    );
    await wrapper.get('[data-testid="menu-take-ours"]').trigger("click");
    await nextTick();
    expect(wrapper.get('[data-testid="take-side-dialog"]').text()).toContain(
      "The revert of a1b2c3d in src/a.ts, and any edit made to it since the conflict, go",
    );
    wrapper.unmount();
  });

  it("offers no side without an operation's sides", async () => {
    const { wrapper } = await mountScreen({ operation: "none", sides: null });
    await conflictRow(wrapper, "src/a.ts").trigger("contextmenu");
    await nextTick();
    expect(wrapper.find('[data-testid="menu-resolve"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="menu-take-ours"]').exists()).toBe(false);
    await conflictRow(wrapper, "src/a.ts").trigger("click");
    await settled();
    const card = wrapper.get('[data-testid="diff-guard"]');
    expect(card.find('[data-testid="diff-guard-take-ours"]').exists()).toBe(false);
    expect(card.text()).toContain("Resolve the conflict in your editor");
    wrapper.unmount();
  });
});
