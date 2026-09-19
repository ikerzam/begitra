import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Toast from "./Toast.vue";

describe("Toast", () => {
  it("announces a success with a green check and no action", () => {
    const wrapper = mountWithI18n(Toast, { props: { kind: "success", message: "Worktree added" } });
    expect(wrapper.attributes("role")).toBe("status");
    expect(wrapper.text()).toBe("Worktree added");
    expect(wrapper.get("svg").classes()).toContain("lucide-check");
    expect(wrapper.get("svg").classes()).toContain("text-ok");
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.classes()).toContain("bg-raised");
    expect(wrapper.classes()).toContain("rounded-lg");
    expect(wrapper.classes()).toContain("shadow-overlay");
  });

  it("announces an error as an alert and offers the git output", async () => {
    const wrapper = mountWithI18n(Toast, {
      props: {
        kind: "error",
        message: "Couldn't add worktree. The path already exists.",
        output: "fatal: '/wt/claude-auth' already exists",
      },
    });
    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.get("svg").classes()).toContain("text-danger");
    const action = wrapper.get("[data-testid='toast-action']");
    expect(action.text()).toBe("Show git output");
    expect(action.attributes("data-variant")).toBe("ghost");
    await action.trigger("click");
    expect(wrapper.emitted("action")).toHaveLength(1);
  });

  it("takes a custom action label, such as Show command or Open", () => {
    const wrapper = mountWithI18n(Toast, {
      props: { kind: "error", message: "Couldn't open the editor.", action: "Show command" },
    });
    expect(wrapper.get("[data-testid='toast-action']").text()).toBe("Show command");
  });

  it("defaults to an info toast and translates the default action", () => {
    const wrapper = mountWithI18n(
      Toast,
      { props: { message: "Indexing", output: "…" } },
      { locale: "es" },
    );
    expect(wrapper.attributes("data-kind")).toBe("info");
    expect(wrapper.get("svg").classes()).toContain("text-info");
    expect(wrapper.get("[data-testid='toast-action']").text()).toBe("Ver la salida de git");
  });
});
