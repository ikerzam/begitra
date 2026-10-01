// Keyboard access to the buttons inside a list row whose list keeps one roving tab stop per
// row (the remotes and stash sheets): the buttons are `tabindex="-1"` and marked
// `data-row-action`, → moves the focus from the row to its first button and on to the next,
// ← back and, from the first, to the row again. Up, down, j and k keep moving between rows
// from wherever the focus is, and Enter on a button is the button's click.

/** The row's action buttons that can take the focus, in order. */
function actionsOf(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>("[data-row-action]")).filter(
    (button) => !button.hasAttribute("disabled"),
  );
}

/** Handles a keydown on a row (`currentTarget`); returns whether it moved the focus. */
export function onRowActionsKeydown(event: KeyboardEvent): boolean {
  const row = event.currentTarget;
  const target = event.target;
  if (!(row instanceof HTMLElement) || !(target instanceof HTMLElement)) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const actions = actionsOf(row);
  const at = actions.indexOf(target);
  let next: HTMLElement | undefined;
  if (event.key === "ArrowRight") {
    next = at < 0 ? actions[0] : actions[at + 1];
  } else if (event.key === "ArrowLeft" && at >= 0) {
    next = actions[at - 1] ?? row;
  }
  if (!next) return false;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  return true;
}

/**
 * Whether a click or a double click happened on one of the row's own controls (a button, a
 * link, a checkbox): two quick clicks on the output toggle are the button's, never the row's
 * double click that opens it.
 */
export function onRowControl(event: Event): boolean {
  const row = event.currentTarget;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const control = target.closest("button, a, input, [role='button'], [role='checkbox']");
  return (
    control !== null && control !== row && (!(row instanceof Element) || row.contains(control))
  );
}
