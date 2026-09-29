// Where the focus goes when a context menu closes: back to what opened it (a row, a list, the
// diff's rows), unless an item moved it elsewhere (a dialog, another screen's field). The menu
// held the focus, so without this it falls to the document's body and the keys stop working.

import { nextTick } from "vue";

/** Runs `focus` on the next tick when nothing but the document's body has the focus. */
export function refocusAfterMenu(focus: () => void): void {
  void nextTick(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) focus();
  });
}
