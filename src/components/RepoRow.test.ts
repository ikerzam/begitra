import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import RepoRow from "./RepoRow.vue";

const repo = {
  name: "geoportal",
  branch: "main",
  lane: 1,
  ahead: 2,
  behind: 0,
  lastCommit: "2h ago",
  path: "~/code/geoportal",
};

describe("RepoRow", () => {
  it("lays out name, branch with lane dot, counts, last commit and mono path", () => {
    const wrapper = mountWithI18n(RepoRow, { props: repo });
    expect(wrapper.attributes("role")).toBe("option");
    expect(wrapper.classes()).toContain("h-row-list");
    expect(wrapper.classes()).toContain("grid");
    expect(wrapper.get("[data-testid='repo-row-name']").text()).toBe("geoportal");
    expect(wrapper.find("[data-testid='repo-row-connector']").exists()).toBe(false);
    const branch = wrapper.get("[data-testid='repo-row-branch']");
    expect(branch.get("[data-lane]").classes()).toContain("bg-lane-1");
    expect(branch.text()).toBe("main");
    expect(wrapper.get("[data-testid='ahead']").text()).toBe("2");
    expect(wrapper.get("[data-testid='repo-row-last-commit']").text()).toBe("2h ago");
    expect(wrapper.get("[data-testid='repo-row-last-commit']").classes()).toContain(
      "text-fg-muted",
    );
    const path = wrapper.get("[data-testid='repo-row-path']");
    expect(path.text()).toBe("~/code/geoportal");
    expect(path.classes()).toContain("font-mono");
    expect(path.classes()).toContain("text-mono-sm");
    expect(path.classes()).toContain("text-fg-muted");
  });

  it("draws the connector for a worktree hanging under its repository and the dirty marker", () => {
    const wrapper = mountWithI18n(RepoRow, {
      props: { ...repo, name: "claude-auth", branch: "claude/fix-auth", nested: true, dirty: true },
    });
    const connector = wrapper.get("[data-testid='repo-row-connector']");
    expect(connector.classes()).toContain("border-l");
    expect(connector.classes()).toContain("border-b");
    expect(connector.classes()).toContain("border-line-strong");
    expect(wrapper.find("[title='Uncommitted changes']").exists()).toBe(true);
  });

  it("selects and activates like every row", async () => {
    const wrapper = mountWithI18n(RepoRow, { props: { ...repo, selected: true } });
    expect(wrapper.classes()).toContain("border-accent");
    expect(wrapper.attributes("aria-selected")).toBe("true");
    await wrapper.trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
    await wrapper.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")).toHaveLength(1);
  });
});
