// The DOM ids of the tab row's tabs and of the layout they control, shared by the row and the
// shell: a tab names the panel it controls, the panel the tab that labels it.

/** The layout below the tab row: the panel every tab controls. */
export const TAB_PANEL_ID = "tab-panel";

/** The element id of the tab of comparison `id`, or of the project's tab for null. */
export function tabElementId(id: number | null): string {
  return id === null ? "tab-project" : `tab-comparison-${id}`;
}
