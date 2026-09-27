// Which project dialog shows: the new-project dialog (from Home, the palette), and
// the edit dialog of one project (from its view's header, its empty Overview, the palette).
// The shell renders them over any layout.

import { defineStore } from "pinia";
import { ref } from "vue";

export const useProjectDialogsStore = defineStore("projectDialogs", () => {
  const creating = ref(false);
  /** The project being edited; null when the edit dialog is closed. */
  const editing = ref<number | null>(null);

  function create(): void {
    editing.value = null;
    creating.value = true;
  }

  function edit(id: number): void {
    creating.value = false;
    editing.value = id;
  }

  function close(): void {
    creating.value = false;
    editing.value = null;
  }

  return { creating, editing, create, edit, close };
});
