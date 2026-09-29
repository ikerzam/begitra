import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ref } from "vue";

import type { FileChange } from "@/ipc/schemas";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { fakeBackend } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import { firstConflictMarker, useFileOpener } from "./useFileOpener";

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

function change(
  path: string,
  status: FileChange["status"],
  hunks: FileChange["hunks"] = [],
): FileChange {
  return {
    status,
    path,
    oldPath: null,
    similarity: null,
    additions: 0,
    deletions: 0,
    hunks,
    isBinary: false,
    isLarge: false,
    isGenerated: false,
    isTest: false,
    isLossy: false,
    oldId: null,
    newId: null,
  };
}

function mountOpener(root: string | null) {
  const wrapper = mountWithI18n({
    template: "<div />",
    setup() {
      return useFileOpener(ref(root));
    },
  });
  return { wrapper, opener: wrapper.vm as unknown as ReturnType<typeof useFileOpener> };
}

describe("useFileOpener", () => {
  it("finds the first conflict marker", () => {
    expect(firstConflictMarker("a\nb\n<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> x\n")).toBe(3);
    expect(firstConflictMarker("no conflict here\n")).toBeNull();
  });

  it("opens a file at its first change, a conflicted one at its first marker", async () => {
    const calls = fakeBackend({ blobTexts: { "src/tiles.ts": "one\n<<<<<<< ours\ntwo\n" } });
    const { wrapper, opener } = mountOpener("/r");
    const modified = change("src/a.ts", "modified", [
      {
        oldStart: 7,
        oldLines: 2,
        newStart: 7,
        newLines: 2,
        header: "@@ -7,2 +7,2 @@",
        lines: [
          { kind: "context", oldNumber: 7, newNumber: 7, text: "a", spans: [], noNewline: false },
          { kind: "added", oldNumber: null, newNumber: 8, text: "b", spans: [], noNewline: false },
        ],
      },
    ]);
    expect(await opener.openFile(modified)).toBe(true);
    expect(await opener.openFile(change("src/tiles.ts", "unmerged"))).toBe(true);
    await flushPromises();
    const opened = calls.filter((call) => call.cmd === "open_external").map((call) => call.args);
    expect(opened.map((args) => [args["path"], args["line"]])).toEqual([
      ["/r/src/a.ts", 8],
      ["/r/src/tiles.ts", 2],
    ]);
    // A deletion has no working-tree file; without a root nothing opens.
    expect(opener.canOpen(change("src/gone.ts", "deleted"))).toBe(false);
    expect(await opener.openFile(change("src/gone.ts", "deleted"))).toBe(false);
    wrapper.unmount();
    const none = mountOpener(null);
    expect(none.opener.canOpen(modified)).toBe(false);
    none.wrapper.unmount();
  });

  it("opens a conflict row's file at its marker, at its top without one", async () => {
    const calls = fakeBackend({ blobTexts: { "a.txt": "<<<<<<< ours\n", "b.txt": "clean\n" } });
    const { wrapper, opener } = mountOpener("/r");
    await opener.openConflict("a.txt");
    await opener.openConflict("b.txt");
    const opened = calls.filter((call) => call.cmd === "open_external").map((call) => call.args);
    expect(opened.map((args) => [args["path"], args["line"]])).toEqual([
      ["/r/a.txt", 1],
      ["/r/b.txt", null],
    ]);
    wrapper.unmount();
  });
});
