<script setup lang="ts">
// The menu of a project on Home: pin or unpin, "Edit project…", open a folder
// project's folder in the terminal or the editor, and "Remove project…", which asks in its own
// confirmation. Fixed at the given viewport position (a right click, the "…", or the keyboard).

import { Code, Pencil, Pin, PinOff, Terminal, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import type { Project } from "@/ipc/schemas";
import { useExternal } from "@/shell/useExternal";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";

const props = defineProps<{ project: Project; x: number; y: number }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();
const external = useExternal();
</script>

<template>
  <ContextMenu
    :x="props.x"
    :y="props.y"
    :label="t('home.rowActions', { name: props.project.name })"
    data-testid="project-row-menu"
    @close="emit('close')"
  >
    <ContextMenuItem
      :label="props.project.pinned ? t('home.unpin') : t('home.pin')"
      :icon="props.project.pinned ? PinOff : Pin"
      data-testid="menu-pin"
      @select="() => void projects.setPinned(props.project.id, !props.project.pinned)"
    />
    <ContextMenuItem
      :label="t('project.edit')"
      :icon="Pencil"
      data-testid="menu-edit"
      @select="dialogs.edit(props.project.id)"
    />
    <template v-if="props.project.folder !== null">
      <ContextMenuItem
        :label="t('palette.commandsById.open-terminal')"
        :icon="Terminal"
        data-testid="menu-terminal"
        @select="() => props.project.folder && void external.openTerminal(props.project.folder)"
      />
      <ContextMenuItem
        :label="t('palette.commandsById.open-editor')"
        :icon="Code"
        data-testid="menu-editor"
        @select="() => props.project.folder && void external.openEditor(props.project.folder)"
      />
    </template>
    <ContextMenuSeparator />
    <ContextMenuItem
      :label="t('home.removeProject')"
      :icon="Trash2"
      destructive
      data-testid="menu-remove"
      @select="dialogs.askDelete(props.project.id)"
    />
  </ContextMenu>
</template>
