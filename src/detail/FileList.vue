<script setup lang="ts">
// The change set as a tree grouped by folder, with the status letter, the kind's icon
// (Appearance) and the stats per file. For the keyboard the files form one list: j/k and the
// arrows move the selection, Enter activates, and the selected row (or the first) is the tab
// stop. Folders keep their own chevron and Left/Right keys. A right click or the menu key on a
// file asks for its menu; the panel owns it.

import { computed, ref } from "vue";

import TreeRow from "@/components/TreeRow.vue";
import type { FileChange } from "@/ipc/schemas";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useSettingsStore } from "@/stores/settings";

import { groupFiles } from "./groupFiles";

/** How a row was selected; the detail panel opens review on a pointer selection only. */
export type SelectTrigger = "keyboard" | "pointer";

const props = withDefaults(
  defineProps<{
    files: FileChange[];
    /** Path of the selected file, if any. */
    selectedPath?: string | null;
    /** Paths marked reviewed, shown with the check. */
    reviewed?: Set<string>;
    /** Files reviewed for another content than they show now. */
    changed?: Set<string>;
    /** Paths the comparison's preview says would conflict. */
    conflicts?: Set<string>;
  }>(),
  {
    selectedPath: null,
    reviewed: () => new Set<string>(),
    changed: () => new Set<string>(),
    conflicts: () => new Set<string>(),
  },
);
const emit = defineEmits<{
  select: [file: FileChange, trigger: SelectTrigger];
  activate: [file: FileChange];
  /** The file's menu at a viewport point (a right click, or the menu key at the row). */
  menu: [file: FileChange, x: number, y: number];
}>();
const settings = useSettingsStore();

const tree = ref<HTMLElement | null>(null);
const collapsed = ref(new Set<string>());
const groups = computed(() => groupFiles(props.files));

/** Files in the order shown, skipping collapsed folders; the keys follow it. */
const displayed = computed(() =>
  groups.value.flatMap((group) =>
    collapsed.value.has(group.folder) ? [] : group.files.map((entry) => entry.file),
  ),
);
const count = computed(() => displayed.value.length);

const selectedIndex = computed({
  get: () => displayed.value.findIndex((file) => file.path === props.selectedPath),
  set: (index: number) => {
    const file = displayed.value[index];
    if (file) emit("select", file, "keyboard");
  },
});
const tabStopPath = computed(() =>
  selectedIndex.value >= 0 ? props.selectedPath : (displayed.value[0]?.path ?? null),
);

function attributeSelector(path: string): string {
  return `[data-path="${path.replace(/["\\]/g, "\\$&")}"]`;
}

const navigation = useListNavigation({
  count,
  selected: selectedIndex,
  onActivate: (index) => {
    const file = displayed.value[index];
    if (file) emit("activate", file);
  },
  rowElement: (index) => {
    const path = displayed.value[index]?.path;
    return path ? tree.value?.querySelector(attributeSelector(path)) : null;
  },
});

function toggle(folder: string): void {
  const next = new Set(collapsed.value);
  if (next.has(folder)) next.delete(folder);
  else next.add(folder);
  collapsed.value = next;
}

/** Collapses every folder, or expands them all when every one is collapsed. */
function collapseAll(): void {
  const folders = groups.value.map((group) => group.folder);
  const allCollapsed = folders.every((folder) => collapsed.value.has(folder));
  collapsed.value = allCollapsed ? new Set() : new Set(folders);
}

function onContextMenu(file: FileChange, event: MouseEvent): void {
  event.preventDefault();
  emit("menu", file, event.clientX, event.clientY);
}

/** The menu key (or Shift+F10) on a focused file opens its menu at the row's corner. */
function onKeydown(event: KeyboardEvent): void {
  const menuKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
  const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-path]");
  const file = row ? props.files.find((candidate) => candidate.path === row.dataset["path"]) : null;
  if (menuKey && row && file) {
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    emit("menu", file, rect.left + 24, rect.bottom);
    return;
  }
  navigation.onKeydown(event);
}

defineExpose({ focus: navigation.focus, collapseAll });
</script>

<template>
  <div ref="tree" role="tree" class="py-1" data-testid="file-list" @keydown="onKeydown">
    <template v-for="group in groups" :key="group.folder">
      <TreeRow
        :name="group.folder"
        kind="folder"
        :expanded="!collapsed.has(group.folder)"
        :count="group.files.length"
        @toggle="toggle(group.folder)"
        @activate="toggle(group.folder)"
      />
      <template v-if="!collapsed.has(group.folder)">
        <TreeRow
          v-for="entry in group.files"
          :key="entry.file.path"
          :name="entry.name"
          :depth="1"
          :status="entry.status"
          :kind-icon="settings.values.fileIcons"
          :added="entry.file.isBinary ? undefined : entry.file.additions"
          :removed="entry.file.isBinary ? undefined : entry.file.deletions"
          :generated="entry.file.isGenerated"
          :binary="entry.file.isBinary"
          :reviewed="props.reviewed.has(entry.file.path)"
          :changed="props.changed.has(entry.file.path)"
          :conflict="props.conflicts.has(entry.file.path)"
          :selected="entry.file.path === props.selectedPath"
          :tab-stop="entry.file.path === tabStopPath"
          :data-path="entry.file.path"
          :data-tooltip="entry.file.path"
          :aria-description="entry.file.path"
          @select="emit('select', entry.file, 'pointer')"
          @activate="emit('activate', entry.file)"
          @contextmenu="(event: MouseEvent) => onContextMenu(entry.file, event)"
        />
      </template>
    </template>
  </div>
</template>
