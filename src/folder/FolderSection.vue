<script setup lang="ts">
// A repository of the folder view: its header, a disclosure that closes and
// opens the section (the chevron, the repository's path under the folder in the section-title
// role, and its branch and number of changed files 16px apart), with "Open {name}" in graph
// focus after it; under it its Unstaged and Staged lists as the changes screen draws them, on
// the repository's own model. Only the section the selection is in marks its row.

import { ChevronDown, ChevronRight, FolderGit2 } from "@lucide/vue";
import { computed, ref, useId } from "vue";
import { useI18n } from "vue-i18n";

import ChangeLists from "@/changes/ChangeLists.vue";
import ChangesScope from "@/changes/ChangesScope.vue";
import IconButton from "@/components/IconButton.vue";
import type { FileChange } from "@/ipc/schemas";
import type { FolderRepository } from "@/stores/folder";

import type { SectionHandle } from "./useFolderKeys";

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
const listsId = useId();
const lists = ref<SectionHandle | null>(null);
/** The changed files; unknown while the lists load or when they failed. */
const count = computed(() => props.repository.view.counts?.changed ?? null);
const branch = computed(() =>
  props.repository.detached ? t("statusBar.detached") : props.repository.branch,
);

defineExpose({
  focus: (): void => lists.value?.focus(),
  moveFile: (step: 1 | -1): boolean => lists.value?.moveFile(step) ?? false,
  selectEdge: (edge: "first" | "last"): boolean => lists.value?.selectEdge(edge) ?? false,
} satisfies SectionHandle);
</script>

<template>
  <section
    class="flex flex-col border-b border-line"
    :aria-label="props.repository.name"
    data-testid="folder-section"
    :data-root="props.repository.root"
  >
    <div class="flex h-panel-header shrink-0 items-center gap-2 pr-2">
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 text-left hover:bg-hover"
        :aria-expanded="!props.collapsed"
        :aria-controls="listsId"
        data-testid="folder-section-toggle"
        @click="emit('toggle')"
      >
        <span class="flex size-icon shrink-0 items-center justify-center">
          <component
            :is="props.collapsed ? ChevronRight : ChevronDown"
            :size="12"
            :stroke-width="1.5"
            aria-hidden="true"
          />
        </span>
        <span
          class="min-w-0 truncate text-lg font-semibold text-fg"
          :data-tooltip="props.repository.root"
          data-testid="folder-section-name"
        >
          {{ props.repository.name }}
        </span>
        <span class="flex min-w-0 items-center gap-4 text-sm text-fg-muted">
          <span v-if="branch" class="truncate" data-testid="folder-section-branch">
            {{ branch }}
          </span>
          <template v-if="count !== null">
            <span
              class="shrink-0 tabular-nums"
              aria-hidden="true"
              data-testid="folder-section-count"
            >
              {{ n(count) }}
            </span>
            <span class="sr-only">{{ t("folder.changedFiles", { n: n(count) }, count) }}</span>
          </template>
        </span>
      </button>
      <IconButton
        :icon="FolderGit2"
        :label="t('folder.openRepositoryNamed', { name: props.repository.name })"
        :tooltip="t('folder.openRepository')"
        data-testid="folder-section-open"
        @click="emit('open')"
      />
    </div>
    <div
      v-show="!props.collapsed"
      :id="listsId"
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
