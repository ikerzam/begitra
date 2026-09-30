// Which project dialog shows: the new-project dialog (Home, the switcher, the
// palette), the edit dialog of one project (the Overview's header, its empty state, Home's row
// menu, the palette), the deletion of one project (Home's row menu and its missing folder, the
// edit dialog, the settings' folders), and the removal of a member from the open project (the
// Overview's missing row, the error state of the repository it shows). The shell renders them
// over any layout; one shows at a time.

import { defineStore } from "pinia";
import { ref } from "vue";

export const useProjectDialogsStore = defineStore("projectDialogs", () => {
  const creating = ref(false);
  /** The project being edited; null when the edit dialog is closed. */
  const editing = ref<number | null>(null);
  /** The project whose deletion asks for confirmation; null when none does. */
  const deleting = ref<number | null>(null);
  /** The member of the open project whose removal asks for confirmation; null when none does. */
  const removing = ref<string | null>(null);

  function close(): void {
    creating.value = false;
    editing.value = null;
    deleting.value = null;
    removing.value = null;
  }

  function create(): void {
    close();
    creating.value = true;
  }

  function edit(id: number): void {
    close();
    editing.value = id;
  }

  function askDelete(id: number): void {
    close();
    deleting.value = id;
  }

  function askRemove(path: string): void {
    close();
    removing.value = path;
  }

  return { creating, editing, deleting, removing, create, edit, askDelete, askRemove, close };
});
