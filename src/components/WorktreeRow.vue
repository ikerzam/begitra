<script setup lang="ts">
// One row of the worktrees table: a grid row of six cells, path, branch
// with its lane dot and dirty dot, state, ahead/behind, last commit and the icon actions.
// The table owns the selection and the roving tab stop; a right click or the menu key asks
// the table for the context menu.

import { CircleAlert, Code, FileDiff, Lock, Terminal, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import AheadBehind from "./AheadBehind.vue";
import DirtyDot from "./DirtyDot.vue";
import IconButton from "./IconButton.vue";
import LaneDot from "./LaneDot.vue";

const props = withDefaults(
  defineProps<{
    path: string;
    branch?: string;
    lane?: number;
    dirty?: boolean;
    locked?: boolean;
    /** Why the worktree is locked, shown as the state's title. */
    lockReason?: string;
    /** The folder is gone; the row can only be pruned. */
    missing?: boolean;
    /** The main checkout: no comparison with main and no remove action. */
    main?: boolean;
    /** Null when the counts are not known (the comparison failed or has not run). */
    ahead?: number | null;
    behind?: number | null;
    /** Subject of the last commit. */
    lastCommit?: string;
    /** Relative date of the last commit ("3h ago"). */
    lastCommitDate?: string;
    selected?: boolean;
    /** Roving tab stop; defaults to the selected row. */
    tabStop?: boolean;
  }>(),
  {
    branch: "",
    lane: 0,
    dirty: false,
    locked: false,
    lockReason: "",
    missing: false,
    main: false,
    ahead: null,
    behind: null,
    lastCommit: "",
    lastCommitDate: "",
    selected: false,
    tabStop: undefined,
  },
);

const emit = defineEmits<{
  select: [];
  activate: [];
  compare: [];
  terminal: [];
  editor: [];
  remove: [];
  /** The context menu, at the pointer or under the row from the keyboard. */
  menu: [x: number, y: number];
}>();

const { t } = useI18n();

function onKeydown(event: KeyboardEvent): void {
  // A key pressed on one of the row's buttons is the button's (Enter clicks it).
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter") {
    event.preventDefault();
    emit("activate");
  } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    emit("menu", rect ? rect.left + 24 : 0, rect ? rect.bottom : 0);
  }
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  emit("select");
  emit("menu", event.clientX, event.clientY);
}
</script>

<template>
  <div
    role="row"
    :aria-selected="props.selected"
    :tabindex="(props.tabStop ?? props.selected) ? 0 : -1"
    data-testid="worktree-row"
    class="worktree-row grid h-row-list items-center gap-4 border-l-2 px-3 text-md whitespace-nowrap"
    :class="props.selected ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover'"
    @click="emit('select')"
    @dblclick="emit('activate')"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
  >
    <span
      role="gridcell"
      class="truncate font-mono text-mono-sm"
      :class="props.missing ? 'text-fg-disabled' : 'text-fg-muted'"
      data-testid="worktree-row-path"
    >
      {{ props.path }}
    </span>
    <span
      role="gridcell"
      class="flex items-center gap-2 overflow-hidden"
      data-testid="worktree-row-branch"
    >
      <LaneDot v-if="props.lane > 0" :lane="props.lane" />
      <span class="truncate" :class="props.missing ? 'text-fg-secondary' : 'text-fg'">
        {{ props.branch }}
      </span>
      <DirtyDot v-if="props.dirty" />
    </span>
    <span
      role="gridcell"
      class="flex items-center gap-2 truncate text-sm"
      :class="props.missing ? 'text-warn' : 'text-fg-muted'"
      :data-tooltip="props.locked && props.lockReason ? props.lockReason : undefined"
      :aria-description="props.locked && props.lockReason ? props.lockReason : undefined"
      data-testid="worktree-row-state"
    >
      <template v-if="props.missing">
        <CircleAlert :size="16" :stroke-width="1.5" aria-hidden="true" class="shrink-0" />
        {{ t("worktreeRow.missing") }}
      </template>
      <template v-else-if="props.locked">
        <Lock :size="16" :stroke-width="1.5" aria-hidden="true" class="shrink-0" />
        {{ t("worktreeRow.locked") }}
      </template>
      <template v-else-if="props.main">{{ t("worktreeRow.main") }}</template>
    </span>
    <span role="gridcell" data-testid="worktree-row-counts">
      <AheadBehind
        v-if="!props.missing && props.ahead !== null && props.behind !== null"
        :ahead="props.ahead"
        :behind="props.behind"
      />
    </span>
    <span
      role="gridcell"
      class="flex items-center gap-2 truncate text-sm text-fg-muted"
      data-testid="worktree-row-commit"
    >
      <template v-if="props.missing">{{ t("worktreeRow.prune") }}</template>
      <template v-else>
        <span class="truncate">{{ props.lastCommit }}</span>
        <span class="shrink-0">{{ props.lastCommitDate }}</span>
      </template>
    </span>
    <span role="gridcell" class="flex items-center gap-1" data-testid="worktree-row-actions">
      <IconButton
        v-if="!props.main && !props.missing"
        :label="t('worktreeRow.compare')"
        :icon="FileDiff"
        tabindex="-1"
        @click.stop="emit('compare')"
      />
      <IconButton
        :label="t('worktreeRow.terminal')"
        :icon="Terminal"
        tabindex="-1"
        @click.stop="emit('terminal')"
      />
      <IconButton
        :label="t('worktreeRow.editor')"
        :icon="Code"
        tabindex="-1"
        @click.stop="emit('editor')"
      />
      <IconButton
        v-if="!props.main"
        :label="t('worktreeRow.remove')"
        :icon="Trash2"
        tabindex="-1"
        @click.stop="emit('remove')"
      />
    </span>
  </div>
</template>

<style scoped>
/* Default column widths; a table overrides them through the variables. */
.worktree-row {
  grid-template-columns:
    var(--worktree-path-w, 200px) var(--worktree-branch-w, 200px) var(--worktree-state-w, 96px)
    var(--worktree-ahead-w, 56px) minmax(0, 1fr) auto;
}
</style>
