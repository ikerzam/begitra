import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DiffLine, FileChange } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { mountWithI18n } from "@/test/mount";

import DiffView from "./DiffView.vue";
import { MAX_LINES } from "./diffRows";

function line(
  n: number,
  kind: DiffLine["kind"] = "context",
  spans: DiffLine["spans"] = [],
): DiffLine {
  return {
    kind,
    oldNumber: kind === "added" ? null : n,
    newNumber: kind === "removed" ? null : n,
    text: `line ${n}`,
    spans,
    noNewline: false,
  };
}

function file(lines: DiffLine[][], extra: Partial<FileChange> = {}): FileChange {
  return {
    status: "modified",
    path: "src/app.ts",
    oldPath: null,
    similarity: null,
    additions: 1,
    deletions: 0,
    hunks: lines.map((hunkLines, i) => ({
      oldStart: i * 10 + 1,
      oldLines: hunkLines.length,
      newStart: i * 10 + 1,
      newLines: hunkLines.length,
      header: `@@ -${i * 10 + 1},${hunkLines.length} +${i * 10 + 1},${hunkLines.length} @@ fn f${i}`,
      lines: hunkLines,
    })),
    isBinary: false,
    isLarge: false,
    isGenerated: false,
    isTest: false,
    ...extra,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
});

afterEach(() => {
  setShortcutRegistry(undefined);
});

describe("DiffView", () => {
  it("renders a header row per hunk and the lines with their emphasis spans", () => {
    const wrapper = mountWithI18n(DiffView, {
      props: { file: file([[line(1), line(2, "added", [{ start: 5, end: 6 }])], [line(11)]]) },
    });
    expect(wrapper.findAll('[data-testid="hunk-row"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="hunk-row-symbol"]').text()).toBe("fn f0");
    const rows = wrapper.findAll('[data-testid="diff-row"]');
    expect(rows.map((row) => row.attributes("data-kind"))).toEqual(["context", "add", "context"]);
    expect(rows[1]?.find(".bg-add-emphasis").text()).toBe("2");
    expect(wrapper.find('[data-testid="diff-truncated"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("cuts a long diff after the line budget and says so", () => {
    const lines = Array.from({ length: MAX_LINES + 1 }, (_, i) => line(i + 1));
    const wrapper = mountWithI18n(DiffView, { props: { file: file([lines]) } });
    expect(wrapper.findAll('[data-testid="diff-row"]')).toHaveLength(MAX_LINES);
    expect(wrapper.get('[data-testid="diff-truncated"]').text()).toBe(
      "Showing the first 1500 lines of this diff.",
    );
    wrapper.unmount();
  });

  it("shows the empty state without a file", () => {
    const wrapper = mountWithI18n(DiffView, { props: { file: null } });
    expect(wrapper.text()).toContain("Select a file to see its diff");
    wrapper.unmount();
  });
});
