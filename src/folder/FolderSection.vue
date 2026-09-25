<script setup lang="ts">
// A repository of the folder view: its header (the chevron that closes and
// opens the section, the repository's path under the folder, its branch, its number of
// changed files and "Open repository") over its Unstaged and Staged lists as the changes
// screen draws them, on the repository's own model. Only the section the selection is in
// marks its row.

import { ChevronDown, ChevronRight, FolderOpen } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import ChangeLists from "@/changes/ChangeLists.vue";
import ChangesScope from "@/changes/ChangesScope.vue";
import IconButton from "@/components/IconButton.vue";
import type { FileChange } from "@/ipc/schemas";
import type { FolderRepository } from "@/stores/folder";

const props = defineProps<{
  repository: FolderRepository;
  collapsed: boolean;
  /** Whether the selection is in this section. */
  active: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  open: [];
  /** A press, a click or the focus in the lists: the selection is here now. */
  activate: [];
  discard: [files: FileChange[]];
  /** The row keys went past the first (-1) or the last (1) row. */
  edge: [direction: 1 | -1];
}>();

const { t, n } = useI18n();
const lists = ref<{
  focus(): void;
  moveFile(step: 1 | -1): boolean;
  selectEdge(edge: "first" | "last"): void;
} | null>(null);
const count = computed(() => props.repository.view.counts?.changed ?? 0);

defineExpose({
  moveFile: (step: 1 | -1): boolean => lists.value?.moveFile(step) ?? false,
  selectEdge: (edge: "first" | "last"): void => lists.value?.selectEdge(edge),
});
</script>

<template>
  <section
    class="flex flex-col border-b border-line"
    :aria-label="props.repository.name"
    data-testid="folder-section"
    :data-root="props.repository.root"
  >
    <div
      class="flex h-control shrink-0 items-center gap-2 px-2"
      data-testid="folder-section-header"
    >
      <IconButton
        :icon="props.collapsed ? ChevronRight : ChevronDown"
        :label="
          props.collapsed
            ? t('folder.expand', { name: props.repository.name })
            : t('folder.collapse', { name: props.repository.name })
        "
        data-testid="folder-section-toggle"
        @click="emit('toggle')"
      />
      <span
        class="min-w-0 truncate text-md font-medium text-fg"
        :data-tooltip="props.repository.root"
        data-testid="folder-section-name"
      >
        {{ props.repository.name }}
      </span>
      <span
        v-if="props.repository.branch"
        class="min-w-0 truncate font-mono text-mono-sm text-fg-muted"
        data-testid="folder-section-branch"
      >
        {{ props.repository.branch }}
      </span>
      <span
        class="ml-auto shrink-0 text-sm text-fg-muted tabular-nums"
        :aria-label="t('folder.changedFiles', { n: n(count) }, count)"
        data-testid="folder-section-count"
      >
        {{ n(count) }}
      </span>
      <IconButton
        :icon="FolderOpen"
        :label="t('folder.openRepository')"
        data-testid="folder-section-open"
        @click="emit('open')"
      />
    </div>
    <div
      v-if="!props.collapsed"
      @pointerdown="emit('activate')"
      @click="emit('activate')"
      @focusin="emit('activate')"
    >
      <ChangesScope :view="props.repository.view">
        <ChangeLists
          ref="lists"
          embedded
          :show-selection="props.active"
          @discard="(files) => emit('discard', files)"
          @edge="(direction) => emit('edge', direction)"
        />
      </ChangesScope>
    </div>
  </section>
</template>
