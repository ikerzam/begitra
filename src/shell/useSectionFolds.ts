// Which of the sidebar's sections are folded. Without a filter, the stored folds (a setting).
// While the filter holds text, a section with matches shows open and one without folded, until
// its header is pressed: it then keeps the state chosen until the filter is cleared, whatever the
// matches do meanwhile, and the stored folds stay as they were.

import { ref, watch, type Ref } from "vue";

import { useSettingsStore, type SidebarSectionId } from "@/stores/settings";

export interface SectionFolds {
  isFolded: (id: SidebarSectionId) => boolean;
  /** Folds or opens a section: for the filter's time while filtering, else in the setting. */
  setFolded: (id: SidebarSectionId, folded: boolean) => void;
}

export function useSectionFolds(
  filtering: Ref<boolean>,
  matches: (id: SidebarSectionId) => number,
): SectionFolds {
  const settings = useSettingsStore();
  const chosen = ref(new Map<SidebarSectionId, boolean>());
  // At once, not before the next render: a filter cleared and typed again in one tick starts afresh.
  watch(
    filtering,
    (now) => {
      if (!now) chosen.value = new Map();
    },
    { flush: "sync" },
  );

  function isFolded(id: SidebarSectionId): boolean {
    if (filtering.value) return chosen.value.get(id) ?? matches(id) === 0;
    return settings.values.sidebarFolded.includes(id);
  }

  function setFolded(id: SidebarSectionId, folded: boolean): void {
    if (filtering.value) {
      chosen.value = new Map(chosen.value).set(id, folded);
      return;
    }
    // The setting changes at once; its write to disk follows a moment later and is not waited for.
    const others = settings.values.sidebarFolded.filter((section) => section !== id);
    void settings.update("sidebarFolded", folded ? [...others, id] : others);
  }

  return { isFolded, setFolded };
}
