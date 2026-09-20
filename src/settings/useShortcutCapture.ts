// While a shortcut row is being changed, the next key combination goes to the settings
// screen store before the registry sees it (capture phase, propagation stopped), so
// pressing the palette's own keys records them instead of opening the palette.

import { onBeforeUnmount, watch } from "vue";

import { useSettingsScreenStore } from "@/stores/settingsScreen";

export function useShortcutCapture(): void {
  const screen = useSettingsScreenStore();

  function onKeydown(event: KeyboardEvent): void {
    if (!screen.capturing) return;
    event.preventDefault();
    event.stopPropagation();
    screen.captured(event);
  }

  watch(
    () => screen.capturing !== null,
    (on) => {
      if (on) window.addEventListener("keydown", onKeydown, true);
      else window.removeEventListener("keydown", onKeydown, true);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown, true);
    screen.cancelCapture();
  });
}
