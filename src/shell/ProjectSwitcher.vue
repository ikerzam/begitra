<script setup lang="ts">
// The project switcher of the top bar: the open project's name with its icon, and
// a menu (overlay treatment, under the button) with the pinned projects, the five most recent,
// "Go to projects", "Open folder…" and "New project…". The open project is marked; ↑↓ move,
// ↵ picks, esc closes.

import { Check, ChevronDown, Folder, FolderOpen, Layers, LayoutGrid, Plus } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import type { Project } from "@/ipc/schemas";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";

const emit = defineEmits<{ openFolder: [] }>();

const { t, n } = useI18n();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();
const format = useDiscoveryFormat();

const open = ref(false);
const button = ref<HTMLElement | null>(null);

const current = computed(() => projects.active);
const label = computed(() => current.value?.name ?? t("topBar.noProject"));
const hasEntries = computed(() => projects.pinned.length > 0 || projects.recent.length > 0);

function toggle(): void {
  open.value = !open.value;
}

/* The button takes the focus at once, and the menu closes before its item acts, so a dialog the
   choice opens ("New project…") returns to it when it closes. The menu's own late close is a
   no-op: a browser renders between an item's click and the menu's listener, and focusing the
   button then would take the focus from the dialog. */
function close(): void {
  if (!open.value) return;
  open.value = false;
  button.value?.focus();
}

function act(action: () => unknown): void {
  close();
  void action();
}

function onButtonKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" && !open.value) {
    event.preventDefault();
    open.value = true;
  }
}

function kindIcon(project: Project | null) {
  return project?.kind === "folder" ? Folder : Layers;
}

function icon(project: Project) {
  return project.id === current.value?.id ? Check : kindIcon(project);
}

/** A folder project's folder, or a list project's count. */
function context(project: Project): string {
  if (project.folder !== null) return format.displayPath(project.folder);
  const count = project.members.length;
  return t("project.repositories", { n: n(count) }, count);
}

function choose(project: Project): void {
  act(() => projects.open(project.id));
}
</script>

<template>
  <div class="relative flex min-w-0 items-center">
    <button
      ref="button"
      type="button"
      class="flex h-control min-w-0 items-center gap-2 rounded-md px-2 text-md font-medium text-fg hover:bg-hover"
      :data-tooltip="t('switcher.label')"
      :aria-description="t('switcher.label')"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-testid="project-switcher"
      @click="toggle"
      @keydown="onButtonKeydown"
    >
      <component
        :is="kindIcon(current)"
        :size="16"
        :stroke-width="1.5"
        aria-hidden="true"
        class="text-fg-secondary"
      />
      <span class="truncate">{{ label }}</span>
      <ChevronDown :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
    </button>
    <ContextMenu
      v-if="open"
      class="switcher-menu absolute top-full left-0 z-40 mt-1"
      :label="t('switcher.label')"
      :anchor="button"
      data-testid="project-switcher-menu"
      @close="close"
    >
      <template v-if="projects.pinned.length > 0">
        <p class="px-2 pt-1 pb-1 text-sm text-fg-muted">{{ t("switcher.pinned") }}</p>
        <ContextMenuItem
          v-for="project in projects.pinned"
          :key="`pinned:${project.id}`"
          :label="project.name"
          :icon="icon(project)"
          :context="context(project)"
          :aria-current="project.id === current?.id ? 'true' : undefined"
          :data-project="project.id"
          @select="choose(project)"
        />
      </template>
      <template v-if="projects.recent.length > 0">
        <p class="px-2 pt-1 pb-1 text-sm text-fg-muted">{{ t("switcher.recent") }}</p>
        <ContextMenuItem
          v-for="project in projects.recent"
          :key="`recent:${project.id}`"
          :label="project.name"
          :icon="icon(project)"
          :context="context(project)"
          :aria-current="project.id === current?.id ? 'true' : undefined"
          :data-project="project.id"
          @select="choose(project)"
        />
      </template>
      <ContextMenuSeparator v-if="hasEntries" />
      <ContextMenuItem
        :label="t('switcher.goToProjects')"
        :icon="LayoutGrid"
        :disabled="current === null"
        data-testid="switcher-home"
        @select="act(() => projects.close())"
      />
      <ContextMenuItem
        :label="t('home.openFolder')"
        :icon="FolderOpen"
        data-testid="switcher-open-folder"
        @select="act(() => emit('openFolder'))"
      />
      <ContextMenuItem
        :label="t('project.new.open')"
        :icon="Plus"
        data-testid="switcher-new-project"
        @select="act(() => dialogs.create())"
      />
    </ContextMenu>
  </div>
</template>

<style scoped>
/* Wide enough for a name and its folder (menus are at least 220px; 360 fits "~/code/…"),
   and scrolling inside the window under the top bar when many projects are pinned. */
.switcher-menu {
  width: 360px;
  max-height: calc(100vh - 64px);
  overflow-y: auto;
}
</style>
