<script setup lang="ts">
// One project on Home: its icon (a folder for a folder project, the layers icon for
// a list project, the alert in `--danger` when its folder was not found), its name, its folder
// in mono (the whole of each in a tooltip), its count and the state of its folder's scan 16px
// apart, what needs attention ("2 with changes · 1 behind", the warnings in `--warn`, "up to
// date" otherwise, nothing until the index is read) and a chevron; the "…" and a right click
// open its menu. The list owns the focus, the selection and the keys.

import { ChevronRight, CircleAlert, Ellipsis, Folder, Layers, Pin } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import type { Project } from "@/ipc/schemas";

import type { AttentionPart } from "./useAttention";
import { onRowControl } from "@/components/useRowActions";

const props = defineProps<{
  project: Project;
  /** The folder as displayed (home abbreviated); empty for a list project. */
  folder: string;
  /** Its count of repositories and worktrees. */
  count: string;
  /** The state of its folder's scan ("queued", "scanning", "not found"); empty when none. */
  scan: string;
  /** The last scans could not read its folder. */
  failed: boolean;
  attention: AttentionPart[];
  /** Whether the index is read, so its members' states are known. */
  attentionKnown: boolean;
  /** Position in the flat list of rows, for the roving focus. */
  index: number;
  selected: boolean;
  tabStop: boolean;
}>();

const emit = defineEmits<{ select: []; activate: []; menu: [x: number, y: number] }>();

const { t } = useI18n();

const icon = computed(() => {
  if (props.failed) return CircleAlert;
  return props.project.kind === "folder" ? Folder : Layers;
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
    emit("activate");
  }
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  emit("menu", event.clientX, event.clientY);
}

function onMore(event: MouseEvent): void {
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  emit("menu", rect.left, rect.bottom + 4);
}
</script>

<template>
  <div
    role="option"
    :aria-selected="props.selected"
    :tabindex="props.tabStop ? 0 : -1"
    :data-index="props.index"
    :data-project="props.project.id"
    data-testid="home-project"
    class="group relative flex h-row-list items-center gap-3 border-l-2 px-3 text-md whitespace-nowrap"
    :class="props.selected ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover'"
    @click="emit('select')"
    @dblclick="(event: MouseEvent) => onRowControl(event) || emit('activate')"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
  >
    <component
      :is="icon"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="shrink-0"
      :class="props.failed ? 'text-danger' : 'text-fg-secondary'"
    />
    <span
      class="project-name truncate text-fg"
      :data-tooltip="props.project.name"
      data-testid="home-project-name"
    >
      {{ props.project.name }}
    </span>
    <Pin
      v-if="props.project.pinned"
      :size="12"
      :stroke-width="1.5"
      class="shrink-0 text-fg-muted"
      :aria-label="t('home.pinned')"
    />
    <span
      v-if="props.folder"
      class="project-folder truncate font-mono text-mono-sm text-fg-muted"
      :data-tooltip="props.project.folder ?? undefined"
      data-testid="home-project-folder"
    >
      {{ props.folder }}
    </span>
    <span class="flex shrink-0 items-center gap-4 text-sm text-fg-muted">
      <span data-testid="home-project-status">{{ props.count }}</span>
      <span
        v-if="props.scan"
        :class="{ 'text-danger': props.failed }"
        data-testid="home-project-scan"
      >
        {{ props.scan }}
      </span>
    </span>
    <span
      class="flex min-w-0 items-center gap-2 truncate text-sm"
      data-testid="home-project-attention"
    >
      <template v-if="!props.attentionKnown" />
      <template v-else-if="props.attention.length === 0">
        <span class="text-fg-muted">{{ t("home.projects.upToDate") }}</span>
      </template>
      <template v-for="(part, at) in props.attention" v-else :key="part.text">
        <span v-if="at > 0" class="text-fg-muted">{{ " · " }}</span>
        <span :class="part.warn ? 'text-warn' : 'text-fg-secondary'">{{ part.text }}</span>
      </template>
    </span>
    <span class="ml-auto flex shrink-0 items-center gap-1">
      <IconButton
        class="opacity-0 group-hover:opacity-100 focus-within:opacity-100"
        :label="t('home.rowActions', { name: props.project.name })"
        :icon="Ellipsis"
        tabindex="-1"
        data-testid="home-project-more"
        @click="onMore"
      />
      <ChevronRight :size="16" :stroke-width="1.5" class="text-fg-muted" aria-hidden="true" />
    </span>
  </div>
</template>

<style scoped>
/* A long name or folder gives way before the counts and the attention line do. */
.project-name {
  max-width: 280px;
}
.project-folder {
  max-width: 320px;
}
</style>
