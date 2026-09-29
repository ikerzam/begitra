import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { FileChange, Hunk } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";
import { fakeBackend, settled } from "@/test/backend";
import { changedFile } from "@/test/changes";

import { textColumnWidth } from "./useColumns";
import { hunkRanges, useHighlight } from "./useHighlight";
import { base64OfText } from "./useImageSides";

const file = {
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
    { oldStart: 40, oldLines: 0, newStart: 41, newLines: 2 },
  ],
} as unknown as FileChange;

describe("hunkRanges", () => {
  it("lists the lines each hunk shows on one side, at least one per hunk", () => {
    expect(hunkRanges(file.hunks, "new")).toEqual([
      { start: 1, end: 4 },
      { start: 41, end: 42 },
    ]);
    expect(hunkRanges(file.hunks, "old")).toEqual([
      { start: 1, end: 3 },
      { start: 40, end: 40 },
    ]);
  });
});

describe("textColumnWidth", () => {
  it("takes the gutters off once for unified and per side for side by side", () => {
    expect(textColumnWidth(1000, "unified")).toBe(1000 - 110);
    expect(textColumnWidth(1000, "side-by-side")).toBe((1000 - 132) / 2);
    expect(textColumnWidth(50, "unified")).toBe(0);
  });
});

describe("base64OfText", () => {
  it("encodes UTF-8, which btoa alone cannot", () => {
    expect(base64OfText("abc")).toBe(btoa("abc"));
    expect(() => btoa("a→")).toThrow();
    expect(base64OfText("a→")).toBe("YeKGkg==");
    expect(base64OfText("añ")).toBe("YcOx");
  });
});

describe("useHighlight", () => {
  afterEach(() => clearMocks());

  function highlighting(first: FileChange) {
    const calls = fakeBackend();
    const file = ref<FileChange | null>(first);
    const hunks = ref<readonly Hunk[]>(first.hunks);
    const scope = effectScope();
    const highlight = scope.run(() =>
      useHighlight(
        ref("/r"),
        ref<ReviewTarget | null>({ kind: "worktree" }),
        file,
        hunks,
        ref(true),
      ),
    );
    if (!highlight) throw new Error("no scope");
    const asked = () => calls.filter((call) => call.cmd === "highlight_file").length;
    const coloured = () => {
      const line = first.hunks[0]?.lines[0];
      return line ? highlight.tokensOf(line).length > 0 : false;
    };
    return { file, hunks, scope, asked, coloured };
  }

  async function arrived(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await settled();
  }

  it("keeps the colours of a file listed again with the same contents", async () => {
    const first = changedFile("src/main.rs", { oldId: "blob-a", newId: "stat:12:1" });
    const { file, scope, asked, coloured } = highlighting(first);
    await arrived();
    expect(asked()).toBe(2);
    expect(coloured()).toBe(true);
    // The change set lists the file again: a new object, the same sides and contents.
    file.value = { ...first, hunks: first.hunks.map((hunk) => ({ ...hunk })) };
    await nextTick();
    expect(coloured()).toBe(true);
    await arrived();
    expect(asked()).toBe(2);
    scope.stop();
  });

  it("asks again when a side's contents change, and draws them plain meanwhile", async () => {
    const first = changedFile("src/main.rs", { oldId: "blob-a", newId: "stat:12:1" });
    const { file, scope, asked, coloured } = highlighting(first);
    await arrived();
    file.value = { ...first, newId: "stat:14:2" };
    await nextTick();
    expect(coloured()).toBe(false);
    await arrived();
    expect(asked()).toBe(4);
    expect(coloured()).toBe(true);
    scope.stop();
  });

  it("asks for the lines of the hunks on screen, those of Show new file included", async () => {
    const first = changedFile("src/main.rs", { oldId: "blob-a", newId: "stat:12:1", hunks: [] });
    const { hunks, scope, asked } = highlighting(first);
    await arrived();
    const before = asked();
    hunks.value = changedFile("src/main.rs").hunks;
    await arrived();
    expect(asked()).toBeGreaterThan(before);
    scope.stop();
  });
});
