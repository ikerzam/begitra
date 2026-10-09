// The commit box's helpers: a recent message of the user's into the fields, a co-author into the
// body's trailers, each list's loading, empty and failure states, the read dropped when its
// list closes first, and the ways a list closes: Esc, a press outside, the focus leaving. The
// screen's single keys never act from an open list.

import { clearMocks } from "@tauri-apps/api/mocks";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts } from "@/shortcuts/useShortcut";
import { useChangesStore } from "@/stores/changes";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import {
  fakeBackend,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { changedFile } from "@/test/changes";
import { mountWithI18n } from "@/test/mount";

import ChangesLayout from "./ChangesLayout.vue";

let uninstall: () => void = () => undefined;

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
  setShortcutRegistry(new ShortcutRegistry("windows"));
  uninstall = installShortcuts(window);
});

afterEach(() => {
  uninstall();
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

async function mountBox(options: FakeBackendOptions = {}) {
  const calls = fakeBackend({
    changes: { unstaged: [changedFile("src/a.ts")], staged: [changedFile("src/c.ts")] },
    ...options,
  });
  await useRepoStore().open("/r");
  await settled();
  const wrapper = mountWithI18n(ChangesLayout, { attachTo: document.body });
  await settled();
  return { wrapper, calls };
}

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);
/** Each row of a list as its parts read, joined by a space. */
const rows = (testid: string) =>
  [...document.querySelectorAll(`[data-testid="${testid}"] [data-testid="helper-row"]`)].map(
    (row) =>
      [...row.querySelectorAll("span")]
        .map((part) => part.textContent?.trim() ?? "")
        .filter((part) => part !== "")
        .join(" "),
  );
const key = (target: Element | null, name: string) =>
  target?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
const shown = (testid: string) => document.querySelector(`[data-testid="${testid}"]`);
const press = (target: Element | null) =>
  target?.dispatchEvent(new Event("pointerdown", { bubbles: true }));

async function open(wrapper: VueWrapper, button: string): Promise<void> {
  await wrapper.get(`[data-testid="${button}"]`).trigger("click");
  await settled();
}

describe("the commit box's helpers", () => {
  it("fills the fields with a recent message of the user's", async () => {
    const { wrapper, calls } = await mountBox();
    await open(wrapper, "commit-recent-messages");
    // The user is the author line the box shows.
    expect(of(calls, "recent_messages")[0]?.args).toMatchObject({
      repo: "/r",
      author: "Iker Z. <iker@x>",
    });
    expect(
      rows("recent-messages-list").map((row) => row.replace(/ \S+ ago$| just now$/, "")),
    ).toEqual(["fix(tiles): keep the cache warm", "fix(tiles): drop stale entries"]);
    const list = document.querySelector('[data-testid="recent-messages-list"] [role="listbox"]');
    expect(document.activeElement).toBe(list);
    // j moves as the arrow does, k back, and Space chooses as Enter does.
    key(list, "j");
    key(list, "k");
    key(list, "ArrowDown");
    key(list, " ");
    await settled();
    expect(useChangesStore().draft).toMatchObject({
      subject: "fix(tiles): drop stale entries",
      body: "The cache kept them.",
    });
    expect(shown("recent-messages-list")).toBeNull();
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="commit-recent-messages"]').element,
    );
    wrapper.unmount();
  });

  it("adds a co-author once, filtered by name", async () => {
    const { wrapper } = await mountBox();
    useChangesStore().setDraft({ subject: "feat: tiles", body: "Speeds up the cache." });
    await open(wrapper, "commit-co-authors");
    expect(rows("co-authors-list")).toEqual([
      "Ana Ruiz ana@example.com 42",
      "Luis Pardo luis@example.com 31",
    ]);
    const field = document.querySelector<HTMLInputElement>(
      '[data-testid="co-authors-list-filter"]',
    );
    expect(document.activeElement).toBe(field);
    if (!field) throw new Error("no filter");
    // In the field, j is a letter: the active row stays.
    const first = field.getAttribute("aria-activedescendant");
    key(field, "j");
    expect(field.getAttribute("aria-activedescendant")).toBe(first);
    field.value = "lu";
    field.dispatchEvent(new Event("input"));
    await settled();
    expect(rows("co-authors-list")).toEqual(["Luis Pardo luis@example.com 31"]);
    key(field, "Enter");
    await settled();
    expect(useChangesStore().draft.body).toBe(
      "Speeds up the cache.\n\nCo-authored-by: Luis Pardo <luis@example.com>",
    );
    await open(wrapper, "commit-co-authors");
    key(shown("co-authors-list-filter"), "ArrowDown");
    key(shown("co-authors-list-filter"), "Enter");
    await settled();
    expect(useChangesStore().draft.body).toBe(
      "Speeds up the cache.\n\nCo-authored-by: Luis Pardo <luis@example.com>",
    );
    wrapper.unmount();
  });

  it("keeps the screen's single keys out of an open list", async () => {
    const { wrapper, calls } = await mountBox();
    const row = wrapper.get('[data-list="unstaged"][data-path="src/a.ts"]').element;
    (row as HTMLElement).focus();
    await open(wrapper, "commit-recent-messages");
    const list = document.querySelector('[data-testid="recent-messages-list"] [role="listbox"]');
    expect(document.activeElement).toBe(list);
    key(list, "s");
    await settled();
    expect(of(calls, "stage_paths")).toHaveLength(0);
    // Esc closes the list alone and gives its button the focus back.
    key(list, "Escape");
    await settled();
    expect(shown("recent-messages-list")).toBeNull();
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="commit-recent-messages"]').element,
    );
    // From the file's row, s stages it.
    (row as HTMLElement).focus();
    key(row, "s");
    await settled();
    expect(of(calls, "stage_paths")[0]?.args["paths"]).toEqual(["src/a.ts"]);
    wrapper.unmount();
  });

  it("closes when the focus leaves it or a press lands outside, not on its button", async () => {
    const { wrapper } = await mountBox();
    await open(wrapper, "commit-co-authors");
    const subject = wrapper.get('[data-testid="commit-subject"]').element as HTMLElement;
    subject.focus();
    await settled();
    expect(shown("co-authors-list")).toBeNull();
    // The focus stays where it went.
    expect(document.activeElement).toBe(subject);
    await open(wrapper, "commit-co-authors");
    press(wrapper.get('[data-testid="commit-co-authors"]').element);
    await settled();
    expect(shown("co-authors-list")).not.toBeNull();
    press(document.body);
    await settled();
    expect(shown("co-authors-list")).toBeNull();
    wrapper.unmount();
  });

  it("says why there is no message, or no author", async () => {
    const { wrapper } = await mountBox({
      recentMessages: { identity: false, messages: [] },
      recentAuthors: [],
    });
    await open(wrapper, "commit-recent-messages");
    expect(shown("recent-messages-list")?.textContent).toContain(
      "Set user.email to see your messages",
    );
    await open(wrapper, "commit-co-authors");
    expect(shown("recent-messages-list")).toBeNull();
    expect(shown("co-authors-list")?.textContent).toContain(
      "No other author in the recent history",
    );
    wrapper.unmount();
  });

  it("says when no author matches the filter", async () => {
    const { wrapper } = await mountBox();
    await open(wrapper, "commit-co-authors");
    const field = shown("co-authors-list-filter") as HTMLInputElement;
    field.value = "nobody";
    field.dispatchEvent(new Event("input"));
    await settled();
    expect(rows("co-authors-list")).toEqual([]);
    expect(shown("co-authors-list")?.textContent).toContain("No author matches");
    expect(field.getAttribute("aria-expanded")).toBe("false");
    key(field, "Enter");
    await settled();
    expect(useChangesStore().draft.body).toBe("");
    wrapper.unmount();
  });

  it("shows the reading, then a failure with git's output one click away", async () => {
    const gate = writeGate();
    const { wrapper } = await mountBox({
      helperGate: gate,
      helperError: { code: "git.cli_failed", message: "read failed", detail: "fatal: bad object" },
    });
    await open(wrapper, "commit-co-authors");
    expect(
      document.querySelectorAll('[data-testid="co-authors-list"] [data-testid="skeleton-row"]'),
    ).toHaveLength(3);
    gate.release();
    await settled();
    const list = shown("co-authors-list");
    expect(list?.textContent).toContain("Couldn't read the list");
    expect(list?.textContent).not.toContain("fatal: bad object");
    // The toggle takes the focus inside the list, and its Enter is its own.
    const toggle = list?.querySelector<HTMLButtonElement>('[data-testid="helper-output-toggle"]');
    toggle?.focus();
    key(toggle ?? null, "Enter");
    await settled();
    expect(shown("co-authors-list")).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    toggle?.click();
    await settled();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(list?.textContent).toContain("fatal: bad object");
    wrapper.unmount();
  });

  it("drops the read of a list closed before its answer", async () => {
    const gate = writeGate();
    const { wrapper, calls } = await mountBox({ helperGate: gate });
    await open(wrapper, "commit-recent-messages");
    const opId = of(calls, "recent_messages")[0]?.args["opId"];
    // While it reads, the list itself holds the focus and its keys.
    expect(document.activeElement).toBe(shown("recent-messages-list"));
    key(document.activeElement, "Escape");
    await settled();
    expect(shown("recent-messages-list")).toBeNull();
    expect(of(calls, "cancel_operation").some((call) => call.args["opId"] === opId)).toBe(true);
    gate.release();
    await settled();
    expect(shown("recent-messages-list")).toBeNull();
    expect(useChangesStore().draft.subject).toBe("");
    wrapper.unmount();
  });

  it("closes when the box stops taking input", async () => {
    const gate = writeGate();
    const { wrapper } = await mountBox({ writeGate: gate });
    useChangesStore().setDraft({ subject: "feat: tiles" });
    await open(wrapper, "commit-co-authors");
    expect(shown("co-authors-list")).not.toBeNull();
    const committing = useChangesStore().commit();
    await settled();
    expect(shown("co-authors-list")).toBeNull();
    gate.release();
    await committing;
    await settled();
    wrapper.unmount();
  });

  it("is unavailable on a clean tree, and Recent messages on an unborn branch", async () => {
    const { wrapper } = await mountBox({ changes: { unstaged: [], staged: [] } });
    expect(
      wrapper.get('[data-testid="commit-recent-messages"]').attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.get('[data-testid="commit-co-authors"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
    clearMocks();
    document.body.innerHTML = "";
    setActivePinia(createPinia());
    await useSettingsStore().init(memoryStorage(), "windows");
    const unborn = await mountBox({ commitContext: { unborn: true } });
    expect(
      unborn.wrapper.get('[data-testid="commit-recent-messages"]').attributes("disabled"),
    ).toBeDefined();
    expect(
      unborn.wrapper.get('[data-testid="commit-co-authors"]').attributes("disabled"),
    ).toBeUndefined();
    unborn.wrapper.unmount();
  });
});
