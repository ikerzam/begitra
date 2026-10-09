// The app's start behind the page's start-up screen (`index.html`, `public/boot.css`): the
// settings are read, then the zoom and the fonts are set, so the shell's first frame has its
// size and its typefaces; the shell renders and the screen leaves in the same update. Right
// clicks open no menu meanwhile, since the shell's guard is not there yet.

import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

import { setLocale } from "@/i18n";
import { loadFonts } from "@/shell/useFonts";
import { applyZoom } from "@/shell/useZoom";
import {
  memoryStorage,
  tauriStorage,
  useSettingsStore,
  type SettingsStorage,
} from "@/stores/settings";

/** The start-up screen `index.html` holds beside `#app`. */
export const START_SCREEN = ".boot";

/** Longest the fonts may hold the start: a slow disk shows the shell in the fallback first. */
export const FONT_WAIT_MS = 300;

/** Whether the app has read its settings and shows the shell. */
export function useStartUp(): Ref<boolean> {
  const settings = useSettingsStore();
  const ready = ref(false);
  const noMenu = (event: MouseEvent): void => event.preventDefault();
  document.addEventListener("contextmenu", noMenu);

  onMounted(async () => {
    await readSettings();
    setLocale(settings.values.locale);
    await Promise.all([applyZoom(settings.values.zoom), fontsOrTimeout()]);
    ready.value = true;
    await nextTick();
    document.querySelector(START_SCREEN)?.remove();
    document.removeEventListener("contextmenu", noMenu);
  });

  onBeforeUnmount(() => document.removeEventListener("contextmenu", noMenu));

  /**
   * The stored settings, or the defaults outside the app (no store to open). Values read stand
   * when a write that tidies an earlier version's keys fails afterwards.
   */
  async function readSettings(): Promise<void> {
    let storage: SettingsStorage;
    try {
      storage = await tauriStorage();
    } catch {
      storage = memoryStorage();
    }
    try {
      await settings.init(storage);
    } catch {
      if (!settings.loaded) await settings.init(memoryStorage());
    }
  }

  return ready;
}

/** The fonts, or [`FONT_WAIT_MS`] at most. */
function fontsOrTimeout(): Promise<unknown> {
  return Promise.race([loadFonts(), new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]);
}
