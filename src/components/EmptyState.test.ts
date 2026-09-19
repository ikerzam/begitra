import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import EmptyState from "./EmptyState.vue";

describe("EmptyState", () => {
  it("shows one sentence in secondary text and no action by default", () => {
    const wrapper = mountWithI18n(EmptyState, {
      props: { message: "No worktrees yet. Add one to work on a branch in its own folder." },
    });
    const message = wrapper.get("p");
    expect(message.text()).toBe("No worktrees yet. Add one to work on a branch in its own folder.");
    expect(message.classes()).toContain("text-fg-secondary");
    expect(wrapper.classes()).toContain("text-center");
    expect(wrapper.findAll("div")).toHaveLength(1);
  });

  it("places the action from the slot under the sentence", () => {
    const wrapper = mountWithI18n(EmptyState, {
      props: { message: "Nothing here." },
      slots: { default: "<button type='button'>Add worktree</button>" },
    });
    expect(wrapper.get("button").text()).toBe("Add worktree");
    expect(wrapper.classes()).toContain("gap-5");
  });
});
