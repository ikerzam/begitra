import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref, shallowRef } from "vue";

import type { DiffLine, Hunk } from "@/ipc/schemas";
import type { FindFile } from "@/review/find";

import { FIND_LIMIT, FIND_WAIT_MS, useFindStore, type FindSource } from "./find";

function line(text: string, kind: DiffLine["kind"] = "added"): DiffLine {
  return { kind, oldNumber: null, newNumber: null, text, spans: [], noNewline: false };
}

function hunk(...texts: string[]): Hunk {
  return {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    header: "@@",
    lines: texts.map((t) => line(t)),
  };
}

function findFile(key: string, ...hunks: Hunk[]): FindFile {
  return { key, path: key, hunks };
}

/** A viewer of `files` that shows `shown`, and counts what it is asked to open. */
function viewer(files: FindFile[], shown: string | null) {
  const list = shallowRef(files);
  const loading = ref(false);
  const state = { shown, opens: 0 };
  const source: FindSource = {
    files: () => list.value,
    open: (file) => {
      state.opens += 1;
      state.shown = file.key;
    },
    shownKey: () => state.shown,
    loading: () => loading.value,
  };
  return { source, list, state, loading };
}

/** Lets the wait and every slice run. */
async function counted(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    vi.advanceTimersByTime(FIND_WAIT_MS);
    await nextTick();
  }
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const changeSet = () => [
  findFile("a.ts", hunk("decodeTile(a)", "nothing")),
  findFile("b.ts", hunk("plain")),
  findFile("c.ts", hunk("decodeTile(c)"), hunk("x = decodeTile(y) + decodeTile(z)")),
];

describe("find store", () => {
  it("counts after the wait, pending meanwhile, and starts on the open file's first match", async () => {
    const find = useFindStore();
    const { source, state } = viewer(changeSet(), "c.ts");
    find.attach(source);
    find.show();
    await counted();
    find.setQuery("decodetile");
    await nextTick();
    vi.advanceTimersByTime(FIND_WAIT_MS - 1);
    await nextTick();
    expect(find.count).toBe(0);
    expect(find.pending).toBe(true);
    await counted();
    expect(find.pending).toBe(false);
    expect(find.count).toBe(4);
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 0, line: 0 });
    expect(state.shown).toBe("c.ts");
    expect(find.byKey.get("a.ts")).toHaveLength(1);
    expect(find.byKey.get("c.ts")).toHaveLength(3);
  });

  it("stays on the open file while typing: no match there counts without a place", async () => {
    const find = useFindStore();
    const { source, state } = viewer(changeSet(), "b.ts");
    find.attach(source);
    const requests = find.revealRequest;
    find.show("decodeTile");
    await counted();
    expect(find.count).toBe(4);
    expect(find.current).toBe(-1);
    expect(state.opens).toBe(0);
    expect(find.revealRequest).toBe(requests);
    // Next goes to the first match after the open file, previous to the last before it.
    find.next();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 0 });
    expect(state.shown).toBe("c.ts");
    find.next();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 1, start: 4 });
    find.next();
    find.next();
    expect(find.currentMatch).toMatchObject({ key: "a.ts" });
    find.previous();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 1, start: 20 });
    expect(find.revealRequest).toBe(requests + 5);
    find.close();
    state.shown = "b.ts";
    find.show("decodeTile");
    await counted();
    find.previous();
    expect(find.currentMatch).toMatchObject({ key: "a.ts" });
  });

  it("shows the open file's match past its card: the viewer is asked even for its own file", async () => {
    const find = useFindStore();
    const { source, state } = viewer(changeSet(), "a.ts");
    find.attach(source);
    find.show("decodeTile");
    await counted();
    expect(find.currentMatch).toMatchObject({ key: "a.ts" });
    expect(state.opens).toBe(1);
  });

  it("counts at once when Enter comes during the wait, then shows the open file's match", async () => {
    const find = useFindStore();
    const { source } = viewer(changeSet(), "a.ts");
    find.attach(source);
    find.show();
    await counted();
    find.setQuery("decodeTile");
    await nextTick();
    find.next();
    vi.advanceTimersByTime(0);
    await nextTick();
    expect(find.count).toBe(4);
    expect(find.currentMatch).toMatchObject({ key: "a.ts" });
  });

  it("matches case when asked and says when nothing matches", async () => {
    const find = useFindStore();
    find.attach(viewer(changeSet(), "a.ts").source);
    find.show("DecodeTile");
    await counted();
    expect(find.count).toBe(4);
    find.setMatchCase(true);
    await counted();
    expect(find.count).toBe(0);
    expect(find.current).toBe(-1);
  });

  it("follows the current match's line when the files are read again", async () => {
    const find = useFindStore();
    const { source, list } = viewer(changeSet(), "a.ts");
    find.attach(source);
    find.show("decodeTile");
    await counted();
    find.next();
    find.next();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 1, start: 4 });
    // A hunk added above: the same line, one hunk down, stays current.
    list.value = [
      ...changeSet().slice(0, 2),
      findFile(
        "c.ts",
        hunk("decodeTile(new)"),
        hunk("decodeTile(c)"),
        hunk("x = decodeTile(y) + decodeTile(z)"),
      ),
    ];
    await counted();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 2, start: 4 });
    // A read that comes back empty first (a full reload) loses nothing.
    list.value = [];
    await counted();
    expect(find.count).toBe(0);
    list.value = changeSet();
    await counted();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 1, start: 4 });
    // That line changed: the next match after it is current.
    list.value = [
      ...changeSet().slice(0, 2),
      findFile("c.ts", hunk("decodeTile(c)"), hunk("x = y", "decodeTile(w)")),
    ];
    await counted();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 1, line: 1 });
  });

  it("tells a line by its text when another at the same offset moves into its place", async () => {
    const find = useFindStore();
    const { source, list } = viewer(
      [findFile("d.ts", hunk("aa decodeTile(1)", "bb decodeTile(2)"))],
      "d.ts",
    );
    find.attach(source);
    find.show("decodeTile");
    await counted();
    find.next();
    expect(find.currentMatch).toMatchObject({ line: 1, text: "bb decodeTile(2)" });
    // A line added above: "aa" now sits where "bb" was; "bb" stays current, a line down.
    list.value = [findFile("d.ts", hunk("zz", "aa decodeTile(1)", "bb decodeTile(2)"))];
    await counted();
    expect(find.currentMatch).toMatchObject({ line: 2, text: "bb decodeTile(2)" });
  });

  it("is pending while the viewer's files are still read", async () => {
    const find = useFindStore();
    const { source, loading } = viewer(changeSet(), "a.ts");
    find.attach(source);
    find.show("decodeTile");
    await counted();
    expect(find.pending).toBe(false);
    loading.value = true;
    expect(find.pending).toBe(true);
  });

  it("closes on the query it comes back to, and F3 reopens it", async () => {
    const find = useFindStore();
    find.attach(viewer(changeSet(), "a.ts").source);
    find.show("decodeTile");
    await counted();
    find.close();
    expect(find.open).toBe(false);
    expect(find.count).toBe(0);
    find.next();
    expect(find.open).toBe(true);
    expect(find.query).toBe("decodeTile");
    await counted();
    expect(find.count).toBe(4);
  });

  it("stops counting at the limit", async () => {
    const find = useFindStore();
    const many = Array.from({ length: 30 }, (_, i) =>
      findFile(`f${i}.ts`, hunk(...Array.from({ length: 500 }, () => "a a a"))),
    );
    find.attach(viewer(many, null).source);
    find.show("a");
    await counted();
    expect(find.count).toBe(FIND_LIMIT);
    expect(find.capped).toBe(true);
  });

  it("closes when the viewer lets go", async () => {
    const find = useFindStore();
    const release = find.attach(viewer(changeSet(), "a.ts").source);
    find.show("decodeTile");
    await counted();
    release();
    expect(find.open).toBe(false);
  });
});
