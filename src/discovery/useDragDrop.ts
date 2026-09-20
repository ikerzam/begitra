// Folders dragged onto the window: Tauri's webview reports enter, over, drop and leave with
// the paths the platform provides. `dragging` drives the drop target; a drop hands the first
// path to `onDrop`. Outside Tauri (tests, a browser) there is no webview and nothing happens.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export interface DragDrop {
  /** Whether a drag is over the window. */
  dragging: Ref<boolean>;
}

export function useDragDrop(onDrop: (path: string) => void): DragDrop {
  const dragging = ref(false);
  let unlisten: UnlistenFn | undefined;
  let disposed = false;

  onMounted(async () => {
    let stop: UnlistenFn;
    try {
      stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        switch (payload.type) {
          case "enter":
          case "over":
            dragging.value = true;
            break;
          case "leave":
            dragging.value = false;
            break;
          case "drop": {
            dragging.value = false;
            const first = payload.paths[0];
            if (first) onDrop(first);
            break;
          }
        }
      });
    } catch {
      return;
    }
    if (disposed) stop();
    else unlisten = stop;
  });

  onBeforeUnmount(() => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  });

  return { dragging };
}
