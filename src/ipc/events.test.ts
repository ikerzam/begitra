import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";

import { onRepoChanged } from "./events";
import type { RepoChanged } from "./schemas";

afterEach(() => {
  clearMocks();
});

describe("onRepoChanged", () => {
  it("delivers the typed payload", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: RepoChanged[] = [];
    const unlisten = await onRepoChanged((change) => seen.push(change));
    await emit("repo:changed", { repo: "/r", kinds: ["refs"], paths: [] });
    // The index fields default as the backend defaults them.
    expect(seen).toEqual([
      { repo: "/r", kinds: ["refs"], paths: [], indexPaths: null, conflictsChanged: false },
    ]);
    unlisten();
  });

  it("drops payloads that do not match the schema", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: RepoChanged[] = [];
    const invalid: string[] = [];
    const unlisten = await onRepoChanged(
      (change) => seen.push(change),
      (issue) => invalid.push(issue),
    );
    await emit("repo:changed", { repo: "/r", kinds: ["everything"], paths: [] });
    expect(seen).toEqual([]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain("repo:changed");
    unlisten();
  });
});
