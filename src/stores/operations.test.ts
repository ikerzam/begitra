import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useOperationsStore } from "./operations";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("operations store", () => {
  it("shows the newest operation, its progress, and forgets finished ones", () => {
    const ops = useOperationsStore();
    expect(ops.isBusy).toBe(false);
    ops.start("walk-1", "operations.loadingHistory");
    ops.start("diff-1", "operations.loadingDiff", 4);
    expect(ops.current?.opId).toBe("diff-1");
    expect(ops.currentFraction).toBe(0);
    ops.progress("diff-1", 3);
    expect(ops.currentFraction).toBe(0.75);
    ops.progress("diff-1", 8, 8);
    expect(ops.currentFraction).toBe(1);
    ops.finish("diff-1");
    expect(ops.current?.opId).toBe("walk-1");
    expect(ops.currentFraction).toBeUndefined();
    ops.finish("walk-1");
    expect(ops.isBusy).toBe(false);
    ops.finish("unknown");
  });

  it("shows a background read only while nothing else runs", () => {
    const ops = useOperationsStore();
    ops.start("read-1", "operations.readingChanges", undefined, { background: true });
    expect(ops.current?.opId).toBe("read-1");
    // An action started after the read shows over it, and a later read does not hide it.
    ops.start("switch-1", "operations.switching");
    ops.start("read-2", "operations.readingRepositories", 4, { background: true });
    expect(ops.current?.opId).toBe("switch-1");
    ops.finish("switch-1");
    // With only reads left, the oldest one shows.
    expect(ops.current?.opId).toBe("read-1");
    ops.finish("read-1");
    expect(ops.current?.opId).toBe("read-2");
  });

  it("restarting an id replaces the previous entry", () => {
    const ops = useOperationsStore();
    ops.start("a", "one");
    ops.start("a", "two");
    expect(ops.operations).toHaveLength(1);
    expect(ops.current?.label).toBe("two");
  });
});
