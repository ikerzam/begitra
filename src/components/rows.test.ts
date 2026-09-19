import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import tokens from "../../design/tokens.json";
import DiffRow from "./DiffRow.vue";
import GraphRow from "./GraphRow.vue";
import HunkRow from "./HunkRow.vue";
import ListRow from "./ListRow.vue";
import PanelHeader from "./PanelHeader.vue";
import RepoRow from "./RepoRow.vue";
import TreeRow from "./TreeRow.vue";
import WorktreeRow from "./WorktreeRow.vue";

const sizes: Record<string, number> = tokens.sizes;

/** Row component → the height utility on its root → the token behind it → the design value. */
const rows = [
  {
    name: "GraphRow",
    mount: () => mountWithI18n(GraphRow, { props: { message: "m" } }),
    utility: "h-row-graph",
    token: "--row-graph",
    px: 28,
  },
  {
    name: "ListRow",
    mount: () => mountWithI18n(ListRow, { props: { name: "main" } }),
    utility: "h-row-list",
    token: "--row-list",
    px: 30,
  },
  {
    name: "RepoRow",
    mount: () => mountWithI18n(RepoRow, { props: { name: "geoportal" } }),
    utility: "h-row-list",
    token: "--row-list",
    px: 30,
  },
  {
    name: "WorktreeRow",
    mount: () => mountWithI18n(WorktreeRow, { props: { path: "/wt/a" } }),
    utility: "h-row-list",
    token: "--row-list",
    px: 30,
  },
  {
    name: "TreeRow",
    mount: () => mountWithI18n(TreeRow, { props: { name: "a.ts" } }),
    utility: "h-row-tree",
    token: "--row-tree",
    px: 26,
  },
  {
    name: "DiffRow",
    mount: () => mountWithI18n(DiffRow),
    utility: "h-row-diff",
    token: "--row-diff",
    px: 20,
  },
  {
    name: "HunkRow",
    mount: () => mountWithI18n(HunkRow, { props: { range: "@@ @@" } }),
    utility: "h-row-hunk",
    token: "--row-hunk",
    px: 28,
  },
  {
    name: "PanelHeader",
    mount: () => mountWithI18n(PanelHeader, { props: { title: "Files" } }),
    utility: "h-panel-header",
    token: "--panel-header",
    px: 32,
  },
];

describe("row heights", () => {
  it.each(rows)(
    "$name uses $utility, which is $px px in design/tokens.json",
    ({ mount, utility, token, px }) => {
      const wrapper = mount();
      expect(wrapper.classes()).toContain(utility);
      expect(wrapper.classes().filter((c) => /^h-/.test(c))).toEqual([utility]);
      expect(sizes[token]).toBe(px);
    },
  );

  it("covers the six heights the design fixes: 28, 30, 26, 20, 28 and 32", () => {
    expect(rows.map((row) => row.px)).toEqual([28, 30, 30, 30, 26, 20, 28, 32]);
  });
});
