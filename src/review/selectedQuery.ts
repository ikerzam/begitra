// What ⌘F looks for when it opens the find: the text selected in a diff's rows, when the
// selection lies on one line; else nothing, and the find comes back to its last query.

/** The text selected in a diff's rows on one line, or "" when there is none. */
export function selectedQuery(): string {
  const selection = window.getSelection();
  const text = selection?.toString() ?? "";
  if (text.trim() === "" || text.includes("\n")) return "";
  const node = selection?.anchorNode ?? null;
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest('[data-testid="diff-body"]') ? text : "";
}
