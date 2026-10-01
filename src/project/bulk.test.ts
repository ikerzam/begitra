import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useBulkStore } from "@/stores/bulk";
import { useIndexStore } from "@/stores/index";
import { useProjectsStore } from "@/stores/projects";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { entryOf, projectOf, summaryOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

import ProjectLayout from "./ProjectLayout.vue";

const GEO = "/home/iker/code/geo";
const api = entryOf(`${GEO}/api`, { summary: summaryOf({ ahead: 2 }) });
const web = entryOf(`${GEO}/web`, { summary: summaryOf({ behind: 1 }) });
const infra = entryOf(`${GEO}/infra`, { summary: summaryOf({ operation: "rebase" }) });
const members = [api, web, infra];

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);
type Wrapper = ReturnType<typeof mountWithI18n>;
const status = (wrapper: Wrapper, name: string) =>
  wrapper
    .findAll('[data-testid="member-row"]')
    .find((row) => row.get('[data-testid="member-name"]').text() === name)
    ?.get('[data-testid="member-status"]')
    .text();

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await settled();
}

async function finished(): Promise<void> {
  const bulk = useBulkStore();
  for (let i = 0; i < 200 && bulk.running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flush();
}

async function mountProject(options: FakeBackendOptions = {}) {
  const calls = fakeBackend({
    repositories: members,
    projects: [
      projectOf(
        1,
        "Geoportal",
        members.map((entry) => entry.path),
      ),
    ],
    summaries: Object.fromEntries(members.map((entry) => [entry.path, entry.summary])),
    changesByRepo: Object.fromEntries(
      members.map((entry) => [entry.path, { unstaged: [], staged: [] }]),
    ),
    ...options,
  });
  const projects = useProjectsStore();
  await Promise.all([projects.load(), useIndexStore().load()]);
  await projects.open(1, "overview");
  const wrapper = mountWithI18n(ProjectLayout, { attachTo: document.body });
  await flush();
  return { calls, wrapper };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
  setShortcutRegistry(undefined);
  document.body.innerHTML = "";
});

describe("the bulk actions", () => {
  it("name the selection's count, or act on every repository", async () => {
    const { wrapper } = await mountProject();
    expect(wrapper.get('[data-testid="bulk-fetch"]').text()).toBe("Fetch all");
    const boxes = wrapper.findAll('[data-testid="member-select"] input');
    await boxes[0]?.setValue(true);
    await boxes[1]?.setValue(true);
    expect(wrapper.get('[data-testid="bulk-fetch"]').text()).toBe("Fetch 2");
    expect(wrapper.get('[data-testid="bulk-pull"]').text()).toBe("Pull 2");
    wrapper.unmount();
  });

  it("confirm a pull with what it pulls and what it skips, then show each row's end", async () => {
    const { calls, wrapper } = await mountProject();
    await wrapper.get('[data-testid="bulk-pull"]').trigger("click");
    await flush();
    const dialog = document.querySelector('[data-testid="bulk-dialog"]');
    expect(dialog?.textContent).toContain("Pull 2 repositories");
    const acting = dialog?.querySelector('[data-testid="bulk-acting"]')?.textContent ?? "";
    expect(acting).toContain("main ← origin/main");
    expect(acting).toContain("1 behind");
    expect(acting).toContain("up to date so far");
    expect(dialog?.querySelector('[data-testid="bulk-skipped"]')?.textContent).toContain(
      "a rebase is in progress",
    );
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]');
    expect(confirm?.textContent?.trim()).toBe("Pull 2, fast-forward only");
    confirm?.click();
    await finished();
    expect(of(calls, "pull")).toHaveLength(2);
    expect(status(wrapper, "api")).toBe("Pulled, fast-forward");
    expect(status(wrapper, "infra")).toBe("Skipped: a rebase is in progress");
    expect(wrapper.get('[data-testid="bulk-summary"]').text()).toBe("2 pulled · 1 skipped");
    await wrapper.get('[data-testid="bulk-done"]').trigger("click");
    expect(wrapper.findAll('[data-testid="branch-group"]').length).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it("show a failure's reason with git's output under the row, and retry it", async () => {
    const { calls, wrapper } = await mountProject({
      networkErrors: {
        [web.path]: {
          code: "git.cli_failed",
          message: "git fetch failed",
          detail: "fatal: unable to access 'https://x/': Could not resolve host: x",
        },
      },
    });
    await wrapper.get('[data-testid="bulk-fetch"]').trigger("click");
    await finished();
    expect(status(wrapper, "web")).toContain("Network unreachable");
    expect(wrapper.get('[data-testid="bulk-summary"]').text()).toBe("2 fetched · 1 failed");
    const toggle = wrapper.get('[data-testid="member-output-toggle"]');
    expect(toggle.attributes("aria-label")).toBe("Show git's output");
    expect(toggle.attributes("data-tooltip")).toBe("Show git's output");
    expect(toggle.find("svg").classes()).toContain("lucide-chevron-right");
    await toggle.trigger("click");
    expect(wrapper.get('[data-testid="member-output"]').text()).toContain("Could not resolve host");
    expect(toggle.attributes("aria-label")).toBe("Hide git's output");
    expect(toggle.find("svg").classes()).toContain("lucide-chevron-down");
    await wrapper.get('[data-testid="bulk-retry"]').trigger("click");
    await finished();
    expect(
      of(calls, "fetch")
        .map((call) => call.args["repo"])
        .at(-1),
    ).toBe(web.path);
    wrapper.unmount();
  });

  it("stop with Stop or Esc, the queued never starting", async () => {
    const { calls, wrapper } = await mountProject({ networkDelayMs: 60_000 });
    await wrapper.get('[data-testid="bulk-fetch"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="bulk-running"]').text()).toContain(
      "Fetching 0 of 3 repositories",
    );
    await wrapper.get('[data-testid="overview-table"]').trigger("keydown", { key: "Escape" });
    await flush();
    expect(useBulkStore().running).toBe(false);
    expect(of(calls, "cancel_operation").length).toBeGreaterThan(0);
    expect(wrapper.get('[data-testid="bulk-summary"]').text()).toBe("3 stopped");
    wrapper.unmount();
  });

  it("ask a name for a switch, and check again as it is typed", async () => {
    const { calls, wrapper } = await mountProject();
    await wrapper.get('[data-testid="bulk-switch"]').trigger("click");
    await flush();
    const confirm = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]');
    expect(confirm()?.disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>('[data-testid="bulk-name"]');
    if (!input) throw new Error("no name field");
    input.value = "main";
    input.dispatchEvent(new Event("input"));
    await flush();
    // Every member is on main already, or in the middle of a rebase.
    expect(confirm()?.disabled).toBe(true);
    input.value = "release/2.4";
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(confirm()?.textContent?.trim()).toBe("Switch 2");
    confirm()?.click();
    await finished();
    expect(of(calls, "switch").map((call) => call.args["target"])).toEqual([
      { kind: "branch", name: "release/2.4" },
      { kind: "branch", name: "release/2.4" },
    ]);
    wrapper.unmount();
  });
});
