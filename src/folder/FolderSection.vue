<script setup lang="ts">
// A repository of the folder view: its 32px header on `--bg-raised`, a
// disclosure that closes and opens the section (the chevron, the repository's path under the
// folder, its branch with the Overview's lane dot, and "4 files" at the end), with "Open {name}"
// in graph focus after it; under it its Unstaged and Staged lists as the changes
// screen draws them, on the repository's own model. Only the section the selection is in marks
// its row.

import { ChevronDown, ChevronRight, Code, SquareArrowOutUpRight } from "@lucide/vue";
import { computed, ref, useId } from "vue";
import { useI18n } from "vue-i18n";

import ChangeLists from "@/changes/ChangeLists.vue";
import ChangesScope from "@/changes/ChangesScope.vue";
import IconButton from "@/components/IconButton.vue";
import LaneDot from "@/components/LaneDot.vue";
import type { FileChange } from "@/ipc/schemas";
import { useExternal } from "@/shell/useExternal";
import type { FolderRepository } from "@/stores/folder";
import { useOverviewStore } from "@/stores/overview";

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
const external = useExternal();
const overview = useOverviewStore();
const listsId = useId();
const lists = ref<SectionHandle | null>(null);
/** The changed files; unknown while the lists load or when they failed. */
const count = computed(() => props.repository.view.counts?.changed ?? null);
const branch = computed(() =>
  props.repository.detached ? t("statusBar.detached") : props.repository.branch,
);
/** The branch's lane in the Overview's branch groups; 0 when it has none (detached, unread). */
const lane = computed(() =>
  props.repository.detached || !props.repository.branch
    ? 0
    : (overview.lanes.get(props.repository.branch) ?? 0),
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
    <div class="flex h-panel-header shrink-0 items-center gap-2 bg-raised pr-2">
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left hover:bg-hover"
        :aria-expanded="!props.collapsed"
        :aria-controls="listsId"
        data-testid="folder-section-toggle"
        @click="emit('toggle')"
      >
        <component
          :is="props.collapsed ? ChevronRight : ChevronDown"
          :size="14"
          :stroke-width="1.5"
          aria-hidden="true"
          class="shrink-0 text-fg-muted"
        />
        <span
          class="min-w-0 truncate text-md font-medium text-fg"
          :data-tooltip="props.repository.root"
          data-testid="folder-section-name"
        >
          {{ props.repository.name }}
        </span>
        <span v-if="branch" class="flex min-w-0 items-center gap-2 text-sm text-fg-secondary">
          <LaneDot v-if="lane > 0" :lane="lane" />
          <span class="truncate" data-testid="folder-section-branch">{{ branch }}</span>
        </span>
        <span
          v-if="count !== null"
          class="ml-auto shrink-0 text-sm text-fg-muted tabular-nums"
          data-testid="folder-section-count"
        >
          {{ t("project.files", { n: n(count) }, count) }}
        </span>
      </button>
      <IconButton
        :icon="Code"
        :label="t('project.editor', { name: props.repository.name })"
        data-testid="folder-section-editor"
        @click="() => void external.openEditor(props.repository.root)"
      />
      <IconButton
        :icon="SquareArrowOutUpRight"
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
