// A conflicted file's blocks on the changes screen: each block with its sides by branch, a side,
// both or an edit written per block, the keys, and "Mark resolved" once no block is left.

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
import { fakeBackend, settled, type Call } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import ChangesLayout from "./ChangesLayout.vue";

const conflicts: Conflict[] = [
  { path: "docs/b.md", kind: "deleted-by-them" },
  { path: "src/a.ts", kind: "both-modified" },
];
const FILE = [
  "const one = 1;",
  "<<<<<<< HEAD",
  'const a = "main";',
  "=======",
  'const a = "develop";',
  'const a2 = "develop";',
  ">>>>>>> develop",
  "const three = 3;",
  "const four = 4;",
  "<<<<<<< HEAD",
  'const b = "main";',
  "=======",
  'const b = "develop";',
  ">>>>>>> develop",
  "const six = 6;",
];

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

async function mountScreen() {
  const calls = fakeBackend({
    operation: "merge",
    conflicts,
    conflictFiles: { "src/a.ts": FILE },
    changes: { unstaged: [unmerged("docs/b.md"), unmerged("src/a.ts")], staged: [] },
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

async function open(wrapper: VueWrapper, path: string): Promise<void> {
  await wrapper.get(`[data-list="conflicts"][data-path="${path}"]`).trigger("click");
  await settled();
}

function press(key: string, options: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options }));
}

const blocks = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="conflict-block"]');

describe("conflict blocks", () => {
  it("shows each block with its sides by branch, and the card for a file without markers", async () => {
    const { wrapper } = await mountScreen();
    await open(wrapper, "src/a.ts");
    const bar = wrapper.get('[data-testid="conflict-blocks-bar"]');
    expect(bar.text()).toContain("2 conflicts");
    expect(bar.text()).toContain("main is current, develop is incoming");
    expect(bar.text()).toContain("Use main's version");
    expect(blocks(wrapper)).toHaveLength(2);
    const first = blocks(wrapper)[0];
    expect(first?.text()).toContain("Conflict 1 of 2");
    expect(first?.text()).toContain("line 2");
    expect(first?.get('[data-testid="conflict-block-ours"]').text()).toBe("Use main's");
    expect(first?.get('[data-testid="conflict-block-theirs"]').text()).toBe("Use develop's");
    expect(first?.get('[data-testid="conflict-block-side-ours"]').text()).toContain(
      'const a = "main";',
    );
    expect(first?.get('[data-testid="conflict-block-side-theirs"]').text()).toContain(
      'const a2 = "develop";',
    );
    // The line before the block and the two after it, the second block's start excluded.
    expect(first?.text()).toContain("const one = 1;");
    expect(first?.text()).toContain("const four = 4;");
    await open(wrapper, "docs/b.md");
    expect(wrapper.find('[data-testid="conflict-block"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="diff-guard"]').exists()).toBe(true);
  });

  it("writes a side from its button, and Undo in the toast puts the block back", async () => {
    const { wrapper, calls } = await mountScreen();
    await open(wrapper, "src/a.ts");
    await blocks(wrapper)[1]?.get('[data-testid="conflict-block-theirs"]').trigger("click");
    await settled();
    expect(of(calls, "resolve_conflict_block")[0]?.args).toMatchObject({
      path: "src/a.ts",
      block: 1,
      resolution: { kind: "theirs" },
    });
    expect(blocks(wrapper)).toHaveLength(1);
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.key).toBe("conflictBlocks.used.ref");
    useToastsStore().act(toast?.id ?? -1);
    await settled();
    expect(blocks(wrapper)).toHaveLength(2);
  });

  it("takes sides with the keys, and edits a block with Ctrl Enter and Esc", async () => {
    const { wrapper, calls } = await mountScreen();
    await open(wrapper, "src/a.ts");
    press("n");
    await nextTick();
    expect(blocks(wrapper)[1]?.classes()).toContain("border-focus");
    press("e");
    await settled();
    const field = wrapper.get<HTMLTextAreaElement>('[data-testid="conflict-block-field"]');
    expect(field.element.value).toBe('const b = "main";\nconst b = "develop";\n');
    expect(document.activeElement).toBe(field.element);
    await field.trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(wrapper.find('[data-testid="conflict-block-field"]').exists()).toBe(false);
    press("e");
    await settled();
    const again = wrapper.get<HTMLTextAreaElement>('[data-testid="conflict-block-field"]');
    await again.setValue('const b = "both";\n');
    await again.trigger("keydown", { key: "Enter", ctrlKey: true });
    await settled();
    expect(of(calls, "resolve_conflict_block").at(-1)?.args["resolution"]).toEqual({
      kind: "text",
      text: 'const b = "both";\n',
    });
    expect(blocks(wrapper)).toHaveLength(1);
    press("c");
    await settled();
    expect(of(calls, "resolve_conflict_block").at(-1)?.args).toMatchObject({
      block: 0,
      resolution: { kind: "ours" },
    });
    expect(wrapper.find('[data-testid="conflict-blocks-done"]').exists()).toBe(true);
  });

  it("offers Mark resolved once no block is left", async () => {
    const { wrapper, calls } = await mountScreen();
    await open(wrapper, "src/a.ts");
    await blocks(wrapper)[0]?.get('[data-testid="conflict-block-both"]').trigger("click");
    await settled();
    await blocks(wrapper)[0]?.get('[data-testid="conflict-block-ours"]').trigger("click");
    await settled();
    const done = wrapper.get('[data-testid="conflict-blocks-done"]');
    expect(done.text()).toContain("No conflict left in a.ts");
    await done.get('[data-testid="conflict-blocks-mark-resolved"]').trigger("click");
    await settled();
    expect(of(calls, "mark_resolved").at(-1)?.args["paths"]).toEqual(["src/a.ts"]);
  });

  it("moves the focus with each step, and takes the incoming side or both with i and b", async () => {
    const { wrapper, calls } = await mountScreen();
    await open(wrapper, "src/a.ts");
    press("n");
    await settled();
    expect(document.activeElement).toBe(blocks(wrapper)[1]?.element);
    press("p");
    await settled();
    expect(document.activeElement).toBe(blocks(wrapper)[0]?.element);
    // Esc leaves the field for the Edit button it came from.
    press("e");
    await settled();
    await wrapper.get('[data-testid="conflict-block-field"]').trigger("keydown", { key: "Escape" });
    await settled();
    expect(document.activeElement).toBe(
      blocks(wrapper)[0]?.get('[data-testid="conflict-block-edit"]').element,
    );
    // A write moves the focus to the block that takes its place.
    press("i");
    await settled();
    expect(of(calls, "resolve_conflict_block").at(-1)?.args).toMatchObject({
      block: 0,
      resolution: { kind: "theirs" },
    });
    expect(blocks(wrapper)).toHaveLength(1);
    expect(document.activeElement).toBe(blocks(wrapper)[0]?.element);
    // The last one moves it to Mark resolved.
    press("b");
    await settled();
    expect(of(calls, "resolve_conflict_block").at(-1)?.args).toMatchObject({
      block: 0,
      resolution: { kind: "both" },
    });
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="conflict-blocks-mark-resolved"]').element,
    );
  });
});
