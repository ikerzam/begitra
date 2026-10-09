import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Conflict } from "@/ipc/schemas";
import {
  fakeBackend,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { repoChange } from "@/test/changes";

import { useConflictBlocksStore } from "./conflictBlocks";
import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { memoryStorage, useSettingsStore } from "./settings";
import { useToastsStore } from "./toasts";

const PATH = "src/tile-cache.ts";
const conflicts: Conflict[] = [{ path: PATH, kind: "both-modified" }];
/** Two blocks as git writes them: main's line against develop's two, then one line each. */
const FILE = [
  "export class TileCache {",
  "<<<<<<< HEAD",
  "  constructor(private readonly limit = 512) {}",
  "=======",
  "  constructor(",
  "    private readonly limit = 512,",
  "  ) {}",
  ">>>>>>> develop",
  "  get(key: string) {",
  "<<<<<<< HEAD",
  "    return this.entries.get(key);",
  "=======",
  "    return this.entries.get(key) ?? null;",
  ">>>>>>> develop",
  "  }",
  "}",
];

async function open(options: FakeBackendOptions = {}): Promise<Call[]> {
  const calls = fakeBackend({
    operation: "merge",
    conflicts,
    conflictFiles: { [PATH]: FILE },
    rootIsPath: true,
    ...options,
  });
  await useRepoStore().open("/r");
  await useSequencerStore().load();
  await settled();
  return calls;
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

async function shown(): Promise<ReturnType<typeof useConflictBlocksStore>> {
  const store = useConflictBlocksStore();
  store.show("/r", PATH);
  await settled();
  return store;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

describe("conflict blocks store", () => {
  it("reads the file's blocks, and keeps the card for a file it cannot read", async () => {
    await open();
    const store = await shown();
    expect(store.state).toBe("ready");
    expect(store.blocks).toHaveLength(2);
    expect(store.blocks[0]?.ours).toEqual({ label: "HEAD", start: 2, end: 3 });
    clearMocks();
    fakeBackend({ conflictFiles: { [PATH]: [...FILE, "<<<<<<< stray"] } });
    await store.read();
    expect(store.state).toBe("unreadable");
    clearMocks();
    fakeBackend({
      conflictErrors: { read: { code: "conflict.unreadable", message: "too large" } },
    });
    await store.read();
    expect(store.state).toBe("unreadable");
    clearMocks();
    fakeBackend({ conflictErrors: { read: { code: "git.cli_failed", message: "git failed" } } });
    await store.read();
    expect(store.state).toBe("failed");
  });

  it("writes a side, says which, and puts the block back from the toast", async () => {
    const calls = await open();
    const store = await shown();
    expect(await store.resolve(0, { kind: "theirs" })).toBe(true);
    expect(of(calls, "resolve_conflict_block")[0]?.args).toMatchObject({
      path: PATH,
      block: 0,
      resolution: { kind: "theirs" },
    });
    expect(store.blocks).toHaveLength(1);
    expect(store.text?.lines.slice(0, 4)).toEqual([
      "export class TileCache {",
      "  constructor(",
      "    private readonly limit = 512,",
      "  ) {}",
    ]);
    const toast = useToastsStore().toasts.at(-1);
    expect(toast).toMatchObject({
      key: "conflictBlocks.used.ref",
      params: { name: "develop", n: 1, file: "tile-cache.ts" },
      sticky: true,
    });
    useToastsStore().act(toast?.id ?? -1);
    await settled();
    expect(of(calls, "undo_conflict_block")).toHaveLength(1);
    expect(store.text?.lines).toEqual(FILE);
    expect(store.blocks).toHaveLength(2);
  });

  it("edits a block from both sides and writes the text", async () => {
    const calls = await open();
    const store = await shown();
    store.startEdit(1);
    expect(store.editing).toBe(1);
    expect(store.draft).toBe(
      "    return this.entries.get(key);\n    return this.entries.get(key) ?? null;\n",
    );
    store.draft = "    return this.entries.get(key) ?? undefined;\n";
    expect(await store.applyEdit()).toBe(true);
    expect(of(calls, "resolve_conflict_block").at(-1)?.args["resolution"]).toEqual({
      kind: "text",
      text: "    return this.entries.get(key) ?? undefined;\n",
    });
    expect(store.editing).toBeNull();
    expect(store.text?.lines).toContain("    return this.entries.get(key) ?? undefined;");
    expect(useToastsStore().toasts.at(-1)?.key).toBe("conflictBlocks.edited");
    store.cancelEdit();
    expect(store.draft).toBe("");
  });

  it("reads a file changed meanwhile again, keeping the text being edited", async () => {
    await open({
      conflictErrors: { resolve: { code: "conflict.file_changed", message: "changed" } },
    });
    const store = await shown();
    store.startEdit(0);
    store.draft = "kept\n";
    expect(await store.applyEdit()).toBe(false);
    const toast = useToastsStore().toasts.at(-1);
    expect(toast).toMatchObject({ kind: "info", key: "errors.conflictFileChanged" });
    expect(store.editing).toBe(0);
    expect(store.draft).toBe("kept\n");
  });

  it("writes one block at a time, and says nothing more once the file left", async () => {
    const gate = writeGate();
    const calls = await open({ conflictGate: gate });
    const store = await shown();
    const first = store.resolve(0, { kind: "ours" });
    await settled();
    expect(await store.resolve(1, { kind: "ours" })).toBe(false);
    expect(store.busy).toBe(true);
    store.close();
    gate.release();
    expect(await first).toBe(true);
    expect(of(calls, "resolve_conflict_block")).toHaveLength(1);
    expect(store.text).toBeNull();
  });

  it("reads again when the watcher reports the file, not another", async () => {
    const calls = await open();
    await shown();
    const reads = of(calls, "conflict_blocks").length;
    const store = useConflictBlocksStore();
    store.onRepoChanged(repoChange({ repo: "/r", kinds: ["status"], paths: ["other.ts"] }));
    await settled();
    expect(of(calls, "conflict_blocks")).toHaveLength(reads);
    store.onRepoChanged(repoChange({ repo: "/r", kinds: ["status"], paths: [PATH] }));
    await settled();
    expect(of(calls, "conflict_blocks")).toHaveLength(reads + 1);
  });

  it("moves between blocks within the list", async () => {
    await open();
    const store = await shown();
    store.move(1);
    expect(store.focused).toBe(1);
    store.move(1);
    expect(store.focused).toBe(1);
    store.move(-5);
    expect(store.focused).toBe(0);
  });

  it("says no conflict is left only of a file whose blocks were written here", async () => {
    await open({ conflictFiles: { [PATH]: ["export class TileCache {", "}"] } });
    const opened = await shown();
    // Resolved in the editor, or a conflict git wrote no marker for: the card stays.
    expect(opened.state).toBe("unreadable");
    expect(opened.noneLeft).toBe(false);
    opened.close();
    clearMocks();
    await open();
    const store = await shown();
    expect(await store.resolve(0, { kind: "ours" })).toBe(true);
    expect(await store.resolve(0, { kind: "ours" })).toBe(true);
    expect(store.noneLeft).toBe(true);
    await store.read();
    expect(store.noneLeft).toBe(true);
    // Undo brings the block back, and with it the file's own reading.
    const toast = useToastsStore().toasts.at(-1);
    useToastsStore().act(toast?.id ?? -1);
    await settled();
    expect(store.blocks).toHaveLength(1);
    expect(store.noneLeft).toBe(false);
  });

  it("follows the block being edited when the file changes, or ends the edit keeping its text", async () => {
    await open();
    const store = await shown();
    store.startEdit(1);
    store.draft = "kept\n";
    // The first block resolved in the editor: the edited one is now the first.
    const firstGone = [FILE[0] ?? "", FILE[2] ?? "", ...FILE.slice(8)];
    clearMocks();
    fakeBackend({ operation: "merge", conflicts, conflictFiles: { [PATH]: firstGone } });
    await store.read();
    expect(store.blocks).toHaveLength(1);
    expect(store.editing).toBe(0);
    expect(store.focused).toBe(0);
    expect(store.draft).toBe("kept\n");
    // The edited block resolved there too: the edit ends, its text in a toast.
    clearMocks();
    fakeBackend({
      operation: "merge",
      conflicts,
      conflictFiles: { [PATH]: [FILE[0] ?? "", FILE[2] ?? "", "}"] },
    });
    await store.read();
    expect(store.editing).toBeNull();
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "conflictBlocks.editLost",
      params: { file: "tile-cache.ts" },
      actionKey: "conflictBlocks.showText",
      output: "kept\n",
      sticky: true,
    });
  });

  it("writes only the block being edited, and only with its text", async () => {
    const calls = await open();
    const store = await shown();
    store.startEdit(0);
    expect(await store.resolve(1, { kind: "ours" })).toBe(false);
    expect(await store.resolve(0, { kind: "theirs" })).toBe(false);
    store.startEdit(1);
    expect(store.editing).toBe(0);
    expect(of(calls, "resolve_conflict_block")).toHaveLength(0);
    expect(await store.applyEdit()).toBe(true);
    expect(of(calls, "resolve_conflict_block")).toHaveLength(1);
  });

  it("does not edit a file that is not UTF-8", async () => {
    const calls = await open();
    const store = await shown();
    const read = store.text;
    if (!read) throw new Error("no text");
    store.text = { ...read, utf8: false };
    store.startEdit(0);
    expect(store.editing).toBeNull();
    expect(useToastsStore().toasts.at(-1)?.key).toBe("conflictBlocks.notUtf8");
    expect(await store.resolve(0, { kind: "text", text: "x\n" })).toBe(false);
    expect(of(calls, "resolve_conflict_block")).toHaveLength(0);
  });

  it("closes the Undo once its file left the conflicts", async () => {
    await open();
    const store = await shown();
    await store.resolve(0, { kind: "ours" });
    const toasts = useToastsStore();
    expect(toasts.actionIn("conflict-block")).toBeDefined();
    useSequencerStore().conflicts = [{ path: "other.ts", kind: "both-modified" }];
    await settled();
    expect(toasts.actionIn("conflict-block")).toBeUndefined();
  });
});
