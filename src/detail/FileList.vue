<script setup lang="ts">
// The change set as a tree grouped by folder, with status letters and stats per file.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import TreeRow from "@/components/TreeRow.vue";
import type { FileChange } from "@/ipc/schemas";

import { groupFiles } from "./groupFiles";

const props = withDefaults(
  defineProps<{
    files: FileChange[];
    /** Path of the selected file, if any. */
    selectedPath?: string | null;
  }>(),
  { selectedPath: null },
);
const emit = defineEmits<{ select: [file: FileChange] }>();

const { t } = useI18n();
const collapsed = ref(new Set<string>());
const groups = computed(() => groupFiles(props.files));

function toggle(folder: string): void {
  const next = new Set(collapsed.value);
  if (next.has(folder)) next.delete(folder);
  else next.add(folder);
  collapsed.value = next;
}
</script>

<template>
  <div role="tree" class="py-1" data-testid="file-list">
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
          :selected="entry.file.path === props.selectedPath"
          :data-path="entry.file.path"
          :title="entry.file.isBinary ? t('detail.binary') : entry.file.path"
          @select="emit('select', entry.file)"
          @activate="emit('select', entry.file)"
        />
      </template>
    </template>
  </div>
</template>
