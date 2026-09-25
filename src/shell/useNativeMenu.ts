// The webview's own context menu ("Save as", "Print", "Inspect") never opens: a right click an
// app menu handled keeps that menu, a text field keeps the
// platform's edit menu, selected text gets the app's text menu, and anything else gets nothing.
// The listener sits on the document in the bubble phase, after every component's handler.

import { onBeforeUnmount, onMounted } from "vue";

import { isEditableTarget } from "@/shortcuts/registry";

/** Where the text menu opens and what it copies. */
export interface TextMenuRequest {
  x: number;
  y: number;
  text: string;
}

export type MenuOutcome = "app" | "native" | "text" | "none";

/** What a right click gets: its app menu, the platform's edit menu, the text menu or nothing. */
export function menuOutcome(event: MouseEvent, selection: Selection | null): MenuOutcome {
  if (event.defaultPrevented) return "app";
  const target = event.target;
  if (isEditableTarget(target as HTMLElement | null)) return "native";
  const text = selection && !selection.isCollapsed ? selection.toString() : "";
  if (text.trim() !== "" && target instanceof Node && selection?.containsNode(target, true)) {
    return "text";
  }
  return "none";
}

/** Guards the document's right clicks while the calling component is mounted. */
export function useNativeMenu(onText: (request: TextMenuRequest) => void): void {
  function listener(event: MouseEvent): void {
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    const outcome = menuOutcome(event, selection);
    if (outcome === "app" || outcome === "native") return;
    event.preventDefault();
    if (outcome === "text") {
      onText({ x: event.clientX, y: event.clientY, text: selection?.toString() ?? "" });
    }
  }
  onMounted(() => document.addEventListener("contextmenu", listener));
  onBeforeUnmount(() => document.removeEventListener("contextmenu", listener));
}
