<script setup lang="ts">
import { CircleAlert } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import AheadBehind from "./AheadBehind.vue";
import DirtyDot from "./DirtyDot.vue";
import LaneDot from "./LaneDot.vue";

const props = withDefaults(
  defineProps<{
    name: string;
    branch?: string;
    lane?: number;
    dirty?: boolean;
    ahead?: number;
    behind?: number;
    /** Relative date of the last commit ("2h ago"). */
    lastCommit?: string;
    path?: string;
    /** A worktree listed under its repository: draws the connector before the name. */
    nested?: boolean;
    /** The folder is gone: the branch cell reads "not found" in the danger colour. */
    missing?: boolean;
    selected?: boolean;
    /** Roving tab stop; defaults to the selected row. Lists without a selection pass it to the first row. */
    tabStop?: boolean;
  }>(),
  {
    branch: "",
    lane: 0,
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommit: "",
    path: "",
    nested: false,
    missing: false,
    selected: false,
    tabStop: undefined,
  },
);

const emit = defineEmits<{ select: []; activate: [] }>();

const { t } = useI18n();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
    emit("activate");
  }
}
</script>

<template>
  <div
    role="option"
    :aria-selected="props.selected"
    :tabindex="(props.tabStop ?? props.selected) ? 0 : -1"
    data-testid="repo-row"
    class="repo-row group relative grid h-row-list items-center gap-4 border-l-2 px-3 text-md whitespace-nowrap"
    :class="props.selected ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover'"
    @click="emit('select')"
    @dblclick="emit('activate')"
    @keydown="onKeydown"
  >
    <span class="flex items-center overflow-hidden" data-testid="repo-row-name">
      <span
        v-if="props.nested"
        aria-hidden="true"
        data-testid="repo-row-connector"
        class="mr-2 ml-1 inline-block size-3 shrink-0 border-b border-l border-line-strong"
      />
      <span class="truncate text-fg">{{ props.name }}</span>
    </span>
    <span
      v-if="props.missing"
      class="flex items-center gap-2 overflow-hidden text-sm text-danger"
      data-testid="repo-row-missing"
    >
      <CircleAlert :size="16" :stroke-width="1.5" aria-hidden="true" class="shrink-0" />
      <span class="truncate">{{ t("repoRow.notFound") }}</span>
    </span>
    <span v-else class="flex items-center gap-2 overflow-hidden" data-testid="repo-row-branch">
      <LaneDot v-if="props.lane > 0" :lane="props.lane" />
      <span class="truncate text-fg">{{ props.branch }}</span>
      <DirtyDot v-if="props.dirty" />
    </span>
    <AheadBehind v-if="!props.missing" :ahead="props.ahead" :behind="props.behind" />
    <span v-else aria-hidden="true" />
    <span class="truncate text-sm text-fg-muted" data-testid="repo-row-last-commit">
      {{ props.lastCommit }}
    </span>
    <span class="truncate font-mono text-mono-sm text-fg-muted" data-testid="repo-row-path">
      {{ props.path }}
    </span>
    <!-- Row actions (the "…" of the home table) sit over the right edge, shown on hover. -->
    <span
      v-if="$slots.actions"
      class="absolute right-3 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100"
      data-testid="repo-row-actions"
    >
      <slot name="actions" />
    </span>
  </div>
</template>

<style scoped>
/* Default column widths; a table overrides them through the variables. */
.repo-row {
  grid-template-columns:
    var(--repo-name-w, 200px) var(--repo-branch-w, 200px) var(--repo-ahead-w, 56px)
    var(--repo-commit-w, 64px) minmax(0, 1fr);
}
</style>
