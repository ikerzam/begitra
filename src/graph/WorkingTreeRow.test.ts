import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { AppError } from "@/ipc/errors";
import { useChangesStore } from "@/stores/changes";
import { useRepoStore } from "@/stores/repo";
import { fakeCommit } from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import { laneX } from "./useGraphGeometry";
import WorkingTreeRow from "./WorkingTreeRow.vue";

/** Sets the loaded lists of the changes store to files at these paths. */
async function lists(unstaged: string[], staged: string[]): Promise<void> {
  const changes = useChangesStore();
  changes.loaded = true;
  changes.unstaged = { ...changes.unstaged, files: unstaged.map((path) => changedFile(path)) };
  changes.staged = { ...changes.staged, files: staged.map((path) => changedFile(path)) };
  await nextTick();
}

function countTexts(wrapper: ReturnType<typeof mountWithI18n>): string[] {
  return wrapper
    .get('[data-testid="working-tree-counts"]')
    .findAll("span")
    .map((part) => part.text());
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("WorkingTreeRow", () => {
  it("shows nothing while the lists have not loaded or are clean", async () => {
    const wrapper = mountWithI18n(WorkingTreeRow);
    expect(wrapper.find('[data-testid="working-tree-row"]').exists()).toBe(false);
    await lists([], []);
    expect(wrapper.find('[data-testid="working-tree-row"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("names the uncommitted changes with both counts and opens the changes screen", async () => {
    await lists(["a.ts", "b.ts"], ["c.ts"]);
    const wrapper = mountWithI18n(WorkingTreeRow);
    const row = wrapper.get('[data-testid="working-tree-row"]');
    expect(row.element.tagName).toBe("BUTTON");
    expect(row.text()).toContain("Uncommitted changes");
    expect(countTexts(wrapper)).toEqual(["2 unstaged", "1 staged"]);
    await row.trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
    wrapper.unmount();
  });

  it("waits for a list that streams, and leaves a count of zero out", async () => {
    const changes = useChangesStore();
    await lists([], ["c.ts"]);
    const wrapper = mountWithI18n(WorkingTreeRow);
    expect(countTexts(wrapper)).toEqual(["1 staged"]);
    // A reload streaming its first page keeps the last counts until it ends.
    changes.unstaged = { ...changes.unstaged, loading: true, files: [changedFile("a.ts")] };
    await nextTick();
    expect(countTexts(wrapper)).toEqual(["1 staged"]);
    changes.unstaged = { ...changes.unstaged, loading: false };
    await nextTick();
    expect(countTexts(wrapper)).toEqual(["1 unstaged", "1 staged"]);
    wrapper.unmount();
  });

  it("formats large counts and says so when the working tree could not be read", async () => {
    const changes = useChangesStore();
    await lists(
      Array.from({ length: 1234 }, (_, at) => `f${at}.ts`),
      [],
    );
    const wrapper = mountWithI18n(WorkingTreeRow);
    expect(countTexts(wrapper)).toEqual(["1,234 unstaged"]);
    changes.unstaged = { ...changes.unstaged, error: new AppError("git.cli_failed", "x") };
    await nextTick();
    expect(wrapper.get('[data-testid="working-tree-failed"]').text()).toBe(
      "Couldn't read the working tree",
    );
    await wrapper.get('[data-testid="working-tree-row"]').trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
    wrapper.unmount();
  });

  it("draws its circle on HEAD's lane, and on the first lane when HEAD is not listed", async () => {
    const repo = useRepoStore();
    repo.commits = [fakeCommit(0), fakeCommit(1), fakeCommit(2)];
    repo.refs = [
      {
        name: "HEAD",
        fullName: "HEAD",
        kind: "head",
        target: fakeCommit(2).hash,
        isCurrent: false,
        upstream: null,
        ahead: null,
        behind: null,
        worktree: null,
        message: null,
      },
    ];
    await lists(["a.ts"], []);
    const wrapper = mountWithI18n(WorkingTreeRow);
    const icon = () => wrapper.get('[data-testid="working-tree-row"] svg').element as SVGElement;
    // Half the 14px icon and the row's 2px border off the lane's x.
    expect(icon().style.left).toBe(`${laneX(2) - 9}px`);
    repo.commits = [fakeCommit(0)];
    await nextTick();
    expect(icon().style.left).toBe(`${laneX(0) - 9}px`);
    wrapper.unmount();
  });

  it("hands the focus back when it goes away while focused", async () => {
    await lists(["a.ts"], []);
    const wrapper = mountWithI18n(WorkingTreeRow, { attachTo: document.body });
    (wrapper.get('[data-testid="working-tree-row"]').element as HTMLElement).focus();
    await lists([], []);
    expect(wrapper.emitted("leave")).toHaveLength(1);
    wrapper.unmount();
  });

  it("renders in Spanish", async () => {
    await lists(["a.ts", "b.ts"], ["c.ts"]);
    const wrapper = mountWithI18n(WorkingTreeRow, {}, { locale: "es" });
    expect(wrapper.text()).toContain("Cambios sin confirmar");
    expect(countTexts(wrapper)).toEqual(["2 sin preparar", "1 preparado"]);
    wrapper.unmount();
  });
});
