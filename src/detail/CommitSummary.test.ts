import { describe, expect, it } from "vitest";

import { fakeCommit } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import CommitSummary from "./CommitSummary.vue";

describe("CommitSummary", () => {
  it("keeps its subject, body and author selectable in a window that selects nothing else", () => {
    const wrapper = mountWithI18n(CommitSummary, { props: { commit: fakeCommit(0), refs: [] } });
    expect(wrapper.get("[data-testid='commit-subject']").classes()).toContain("select-text");
    expect(wrapper.get("[data-testid='commit-body']").classes()).toContain("select-text");
    expect(wrapper.get("[data-testid='commit-body']").text()).toBe("body of 0");
    // The parent link is a button: the hand, not the I-beam, and not part of the selection.
    expect(wrapper.get("[data-testid='parent-link']").element.closest(".select-text")).toBeNull();
  });
});
