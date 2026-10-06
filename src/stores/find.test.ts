import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, shallowRef } from "vue";

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

/** A viewer of `files` that shows `shown` and records what it is asked to open. */
function viewer(files: FindFile[], shown: string | null) {
  const list = shallowRef(files);
  const state = { shown, opened: [] as string[] };
  const source: FindSource = {
    files: () => list.value,
    open: (file) => {
      state.opened.push(file.key);
      state.shown = file.key;
    },
    shownKey: () => state.shown,
  };
  return { source, list, state };
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
  it("counts after the wait and starts on the open file's first match", async () => {
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
    await counted();
    expect(find.count).toBe(4);
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 0, line: 0 });
    expect(state.opened).toEqual([]);
    expect(find.byKey.get("a.ts")).toHaveLength(1);
    expect(find.byKey.get("c.ts")).toHaveLength(3);
  });

  it("moves across files both ways and wraps, opening the file a match is in", async () => {
    const find = useFindStore();
    const { source, state } = viewer(changeSet(), "b.ts");
    find.attach(source);
    find.show("decodeTile");
    await counted();
    // From b.ts the first match after it is c.ts's.
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 0 });
    const requests = find.revealRequest;
    find.next();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 1, start: 4 });
    find.next();
    find.next();
    expect(find.currentMatch).toMatchObject({ key: "a.ts" });
    expect(state.opened).toEqual(["c.ts", "a.ts"]);
    find.previous();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 1, start: 20 });
    expect(find.revealRequest).toBe(requests + 4);
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

  it("keeps the current match when the files are read again, else the next one after it", async () => {
    const find = useFindStore();
    const { source, list } = viewer(changeSet(), "a.ts");
    find.attach(source);
    find.show("decodeTile");
    await counted();
    find.next();
    find.next();
    expect(find.currentMatch).toMatchObject({ key: "c.ts", hunk: 1, start: 4 });
    // The same lines again: the same match stays current.
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
