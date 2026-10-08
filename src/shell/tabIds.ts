// The DOM ids of the tab row's tabs and of the layout they control, shared by the row and the
// shell: a tab names the panel it controls, the panel the tab that labels it.

import type { TabKey } from "@/stores/tabs";

/** The layout below the tab row: the panel every tab controls. */
export const TAB_PANEL_ID = "tab-panel";

/** The element id of a tab: a fixed one's or Home's by its kind, an open one's by its id. */
export function tabElementId(key: TabKey): string {
  return typeof key === "number" ? `tab-open-${key}` : `tab-${key}`;
}
