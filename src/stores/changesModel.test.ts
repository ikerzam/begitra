import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope } from "vue";

import { fakeBackend, FAKE_COMMIT_HASH, settled, type Call } from "@/test/backend";
import { changedFile, repoChange } from "@/test/changes";

import { useChangesStore } from "./changes";
import { createChangesModel } from "./changesModel";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

/** A model of `root` in a scope of its own, as the folder view makes one. */
function modelOf(root: string, onCommitted?: (hash: string) => void) {
  const scope = effectScope();
  const model = scope.run(() => createChangesModel({ root: () => root, onCommitted }));
  if (!model) throw new Error("no model");
  return { model, scope };
}

describe("createChangesModel", () => {
  it("reads and writes the repository it is made for, whichever is open", async () => {
    const calls = fakeBackend({
      changes: { unstaged: [changedFile("src/a.ts"), changedFile("src/b.ts")], staged: [] },
    });
    await useRepoStore().open("/r");
    await settled();
    const committed: string[] = [];
    const { model, scope } = modelOf("/web", (hash) => committed.push(hash));
    expect(model.root.value).toBe("/web");
    model.load();
    await model.settled();
    expect(model.unstaged.value.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(model.counts.value).toEqual({ unstaged: 2, staged: 0, changed: 2 });
    const reads = of(calls, "diff").filter((call) => call.args["repo"] === "/web");
    expect(reads).toHaveLength(2);
    await model.stage(["src/a.ts"]);
    expect(of(calls, "stage_paths").at(-1)?.args).toMatchObject({
      repo: "/web",
      paths: ["src/a.ts"],
    });
    model.setDraft({ subject: "fix: tiles" });
    expect(await model.commit()).toBe(true);
    expect(of(calls, "commit").at(-1)?.args).toMatchObject({ repo: "/web" });
    expect(committed).toEqual([FAKE_COMMIT_HASH]);
    // The open repository's store knows nothing of it.
    expect(useChangesStore().draft.subject).toBe("");
    scope.stop();
  });

  it("follows the changes named for its repository", async () => {
    const calls = fakeBackend({ changes: { unstaged: [changedFile("src/a.ts")], staged: [] } });
    const { model, scope } = modelOf("/web");
    model.load();
    await model.settled();
    const before = of(calls, "diff_paths").length;
    model.onRepoChanged(repoChange({ repo: "/web", kinds: ["status"], paths: ["src/a.ts"] }));
    await model.settled();
    expect(of(calls, "diff_paths").slice(before)).toHaveLength(1);
    expect(of(calls, "diff_paths").at(-1)?.args).toMatchObject({
      repo: "/web",
      paths: ["src/a.ts"],
    });
    scope.stop();
  });
});
