<script setup lang="ts">
// The change set as a tree grouped by folder, with status letters and stats per file. For the
// keyboard the files form one list: j/k and the arrows move the selection, Enter activates,
// and the selected row (or the first) is the tab stop. Folders keep their own chevron and
// Left/Right keys.

import { computed, ref } from "vue";

import TreeRow from "@/components/TreeRow.vue";
import type { FileChange } from "@/ipc/schemas";
import { useListNavigation } from "@/shortcuts/useListNavigation";

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
    /** Paths the comparison's preview says would conflict. */
    conflicts?: Set<string>;
  }>(),
  { selectedPath: null, reviewed: () => new Set<string>(), conflicts: () => new Set<string>() },
);
const emit = defineEmits<{
  select: [file: FileChange, trigger: SelectTrigger];
  activate: [file: FileChange];
}>();

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

defineExpose({ focus: navigation.focus, collapseAll });
</script>

<template>
  <div ref="tree" role="tree" class="py-1" data-testid="file-list" @keydown="navigation.onKeydown">
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
          :added="entry.file.isBinary ? undefined : entry.file.additions"
          :removed="entry.file.isBinary ? undefined : entry.file.deletions"
          :generated="entry.file.isGenerated"
          :binary="entry.file.isBinary"
          :reviewed="props.reviewed.has(entry.file.path)"
          :conflict="props.conflicts.has(entry.file.path)"
          :selected="entry.file.path === props.selectedPath"
          :tab-stop="entry.file.path === tabStopPath"
          :data-path="entry.file.path"
          :title="entry.file.path"
          @select="emit('select', entry.file, 'pointer')"
          @activate="emit('activate', entry.file)"
        />
      </template>
    </template>
  </div>
</template>
