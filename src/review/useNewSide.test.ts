import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { FileChange, Hunk } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";
import { fakeBackend, settled, type FakeBackendOptions } from "@/test/backend";
import { changedFile } from "@/test/changes";

import { useNewSide } from "./useNewSide";

afterEach(() => clearMocks());

/** The fake backend's new side of every path: what `changedFile`'s hunk was computed from. */
const FAKE_LINES = ["fn main() {", "    new();", "    more();", "}"];

function reading(first: FileChange, options: FakeBackendOptions = {}, on = true) {
  const calls = fakeBackend(options);
  const file = ref<FileChange | null>(first);
  const hunks = ref<readonly Hunk[]>(first.hunks);
  const enabled = ref(on);
  const scope = effectScope();
  const side = scope.run(() =>
    useNewSide(ref("/r"), ref<ReviewTarget | null>({ kind: "worktree" }), file, hunks, enabled),
  );
  if (!side) throw new Error("no scope");
  const reads = () => calls.filter((call) => call.cmd === "read_blob");
  return { side, file, hunks, enabled, scope, reads };
}

async function arrived(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await settled();
}

describe("useNewSide", () => {
  it("reads the working tree's side once and gives its lines while they match the hunks", async () => {
    const first = changedFile("src/main.rs", { newId: "blob-b" });
    const { side, file, scope, reads } = reading(first);
    expect(side.loading.value).toBe(true);
    expect(side.state.value).toBe("loading");
    await arrived();
    expect(side.state.value).toBe("ready");
    expect(reads()).toHaveLength(1);
    expect(reads()[0]?.args).toMatchObject({ path: "src/main.rs", at: { kind: "working-tree" } });
    expect(side.lines.value).toEqual(FAKE_LINES);
    expect(side.loading.value).toBe(false);
    // Listed again with the same contents: nothing is read, the lines stay.
    file.value = { ...first, hunks: first.hunks.map((hunk) => ({ ...hunk })) };
    await arrived();
    expect(reads()).toHaveLength(1);
    expect(side.lines.value).toEqual(FAKE_LINES);
    scope.stop();
  });

  it("keeps the lines read while the same file is read again, then takes the new ones", async () => {
    const first = changedFile("src/main.rs", { newId: "blob-b" });
    const { side, file, scope, reads } = reading(first);
    await arrived();
    file.value = { ...first, newId: "blob-c" };
    await nextTick();
    expect(side.lines.value).toEqual(FAKE_LINES);
    await arrived();
    expect(reads()).toHaveLength(2);
    // Another file starts without lines until its own arrive.
    file.value = changedFile("src/other.rs", { newId: "blob-d" });
    await nextTick();
    expect(side.lines.value).toBeNull();
    await arrived();
    expect(side.lines.value).toEqual(FAKE_LINES);
    scope.stop();
  });

  it("gives no lines when the file moved since its hunks were computed", async () => {
    const { side, scope } = reading(changedFile("src/main.rs", { newId: "blob-b" }), {
      blobTexts: { "src/main.rs": "// a line added above\nfn main() {\n    new();\n}\n" },
    });
    await arrived();
    expect(side.lines.value).toBeNull();
    expect(side.state.value).toBe("stale");
    scope.stop();
  });

  it("reads nothing for a file whose hunks leave no line out, or while disabled", async () => {
    for (const extra of [
      { status: "added" as const },
      { status: "deleted" as const },
      { isBinary: true },
    ]) {
      const { side, scope, reads } = reading(changedFile("src/main.rs", extra));
      await arrived();
      expect(reads()).toHaveLength(0);
      expect(side.lines.value).toBeNull();
      expect(side.state.value).toBe("failed");
      scope.stop();
    }
    // Disabled (a card shows the file, or "Show new file" its own hunk): nothing until enabled.
    const { side, enabled, scope, reads } = reading(changedFile("src/main.rs"), {}, false);
    await arrived();
    expect(reads()).toHaveLength(0);
    enabled.value = true;
    await arrived();
    expect(reads()).toHaveLength(1);
    expect(side.lines.value).toEqual(FAKE_LINES);
    scope.stop();
  });
});
