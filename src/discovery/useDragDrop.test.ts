import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import { mountWithI18n } from "@/test/mount";

import DropTarget from "./DropTarget.vue";
import { useDragDrop } from "./useDragDrop";

type DragHandler = (event: { payload: unknown }) => void;
const dragHandlers: DragHandler[] = [];
const unlistenDrag = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: DragHandler) => {
      dragHandlers.push(handler);
      return Promise.resolve(unlistenDrag);
    },
  }),
}));

afterEach(() => {
  dragHandlers.length = 0;
  unlistenDrag.mockClear();
});

/** The drop target driven by `useDragDrop`, and the paths it hands on. */
function mountHost() {
  const dropped: string[] = [];
  const Host = defineComponent({
    setup() {
      const { dragging } = useDragDrop((path) => dropped.push(path));
      return () => h(DropTarget, { active: dragging.value });
    },
  });
  return { wrapper: mountWithI18n(Host), dropped };
}

describe("drag and drop", () => {
  it("shows the target on enter, hides it on leave and opens the first dropped path", async () => {
    const { wrapper, dropped } = mountHost();
    await flushPromises();
    expect(dragHandlers).toHaveLength(1);
    const emit = (payload: unknown) => dragHandlers[0]?.({ payload });
    expect(wrapper.find('[data-testid="drop-target"]').exists()).toBe(false);
    emit({ type: "enter", paths: ["/home/iker/code/geoportal"], position: { x: 1, y: 1 } });
    await flushPromises();
    expect(wrapper.get('[data-testid="drop-target"]').text()).toBe("Drop a folder to open it");
    emit({ type: "over", position: { x: 2, y: 2 } });
    emit({ type: "leave" });
    await flushPromises();
    expect(wrapper.find('[data-testid="drop-target"]').exists()).toBe(false);
    emit({ type: "enter", paths: ["/home/iker/code/geoportal"], position: { x: 1, y: 1 } });
    emit({
      type: "drop",
      paths: ["/home/iker/code/geoportal", "/other"],
      position: { x: 1, y: 1 },
    });
    await flushPromises();
    expect(dropped).toEqual(["/home/iker/code/geoportal"]);
    expect(wrapper.find('[data-testid="drop-target"]').exists()).toBe(false);
    wrapper.unmount();
    expect(unlistenDrag).toHaveBeenCalledTimes(1);
  });

  it("neither shows the target nor opens a folder while a modal overlay is open", async () => {
    const { wrapper, dropped } = mountHost();
    await flushPromises();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    const emit = (payload: unknown) => dragHandlers[0]?.({ payload });
    emit({ type: "enter", paths: ["/home/iker/code/geoportal"], position: { x: 1, y: 1 } });
    await flushPromises();
    expect(wrapper.find('[data-testid="drop-target"]').exists()).toBe(false);
    emit({ type: "drop", paths: ["/home/iker/code/geoportal"], position: { x: 1, y: 1 } });
    await flushPromises();
    expect(dropped).toEqual([]);
    modal.remove();
    wrapper.unmount();
  });
});
