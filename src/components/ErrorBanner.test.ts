import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import ErrorBanner from "./ErrorBanner.vue";

const message =
  "Couldn't read /wt/claude-auth. The folder was removed. Prune worktrees to clean this up.";
const output = "fatal: '/wt/claude-auth' is not a working tree\nhint: run 'git worktree prune'";

describe("ErrorBanner", () => {
  it("explains the error inline with a danger icon and no fill", () => {
    const wrapper = mountWithI18n(ErrorBanner, { props: { message } });
    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.get("p").text()).toBe(message);
    expect(wrapper.get("svg").classes()).toContain("text-danger");
    expect(wrapper.classes()).toContain("rounded-md");
    expect(wrapper.classes()).toContain("border-line-strong");
    expect(wrapper.classes()).toContain("p-3");
    expect(wrapper.classes().some((c) => c.startsWith("bg-"))).toBe(false);
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("offers the action as a secondary button", async () => {
    const wrapper = mountWithI18n(ErrorBanner, { props: { message, action: "Prune worktrees" } });
    const button = wrapper.get("button");
    expect(button.text()).toBe("Prune worktrees");
    expect(button.attributes("data-variant")).toBe("secondary");
    await button.trigger("click");
    expect(wrapper.emitted("action")).toHaveLength(1);
  });

  it("keeps the git output one click away behind a disclosure", async () => {
    const wrapper = mountWithI18n(ErrorBanner, { props: { message, output } });
    const toggle = wrapper.get("[data-testid='error-banner-toggle']");
    expect(toggle.text()).toBe("Show git output");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find("[data-testid='error-banner-output']").exists()).toBe(false);

    await toggle.trigger("click");
    expect(toggle.text()).toBe("Hide git output");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    const pre = wrapper.get("[data-testid='error-banner-output']");
    expect(pre.text()).toBe(output);
    expect(pre.classes()).toContain("font-mono");
    expect(pre.classes()).toContain("text-mono-sm");
    expect(toggle.attributes("aria-controls")).toBe(pre.attributes("id"));

    await toggle.trigger("click");
    expect(wrapper.find("[data-testid='error-banner-output']").exists()).toBe(false);
  });

  it("can start with the output expanded and translates the disclosure", () => {
    const wrapper = mountWithI18n(
      ErrorBanner,
      { props: { message, output, open: true } },
      { locale: "es" },
    );
    expect(wrapper.get("[data-testid='error-banner-toggle']").text()).toBe(
      "Ocultar la salida de git",
    );
    expect(wrapper.get("[data-testid='error-banner-output']").text()).toBe(output);
  });
});
