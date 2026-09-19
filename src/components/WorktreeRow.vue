<script setup lang="ts">
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
    /** The folder is gone; the row can only be pruned. */
    missing?: boolean;
    /** The main checkout: no diff against main and no remove action. */
    main?: boolean;
    ahead?: number;
    behind?: number;
    /** Subject of the last commit. */
    lastCommit?: string;
    /** Relative date of the last commit ("3h ago"). */
    lastCommitDate?: string;
    selected?: boolean;
  }>(),
  {
    branch: "",
    lane: 0,
    dirty: false,
    locked: false,
    missing: false,
    main: false,
    ahead: 0,
    behind: 0,
    lastCommit: "",
    lastCommitDate: "",
    selected: false,
  },
);

const emit = defineEmits<{
  select: [];
  activate: [];
  diff: [];
  terminal: [];
  editor: [];
  remove: [];
}>();

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
    :tabindex="props.selected ? 0 : -1"
    data-testid="worktree-row"
    class="worktree-row grid h-row-list items-center gap-4 border-l-2 px-3 text-md whitespace-nowrap"
    :class="props.selected ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover'"
    @click="emit('select')"
    @dblclick="emit('activate')"
    @keydown="onKeydown"
  >
    <span
      class="truncate font-mono text-mono-sm"
      :class="props.missing ? 'text-fg-disabled' : 'text-fg-muted'"
      data-testid="worktree-row-path"
    >
      {{ props.path }}
    </span>
    <span class="flex min-w-0 items-center gap-2" data-testid="worktree-row-branch">
      <LaneDot v-if="props.lane > 0" :lane="props.lane" />
      <span class="truncate text-fg">{{ props.branch }}</span>
      <DirtyDot v-if="props.dirty" />
    </span>
    <span
      class="flex items-center gap-2 truncate"
      :class="props.missing ? 'text-warn' : 'text-fg-secondary'"
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
    <span data-testid="worktree-row-counts">
      <AheadBehind v-if="!props.missing" :ahead="props.ahead" :behind="props.behind" />
    </span>
    <span
      class="flex min-w-0 items-center gap-2 truncate text-fg-muted"
      data-testid="worktree-row-commit"
    >
      <template v-if="props.missing">{{ t("worktreeRow.prune") }}</template>
      <template v-else>
        <span class="truncate">{{ props.lastCommit }}</span>
        <span class="shrink-0">{{ props.lastCommitDate }}</span>
      </template>
    </span>
    <span class="flex items-center gap-1" data-testid="worktree-row-actions">
      <IconButton
        v-if="!props.main"
        :label="t('worktreeRow.diff')"
        :icon="FileDiff"
        @click.stop="emit('diff')"
      />
      <IconButton
        :label="t('worktreeRow.terminal')"
        :icon="Terminal"
        @click.stop="emit('terminal')"
      />
      <IconButton :label="t('worktreeRow.editor')" :icon="Code" @click.stop="emit('editor')" />
      <IconButton
        v-if="!props.main"
        :label="t('worktreeRow.remove')"
        :icon="Trash2"
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
