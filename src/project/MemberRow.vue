<script setup lang="ts">
// One member of the project Overview: the checkbox, the name (with the worktree
// icon for a linked worktree), the branch with its lane dot and dirty dot, ahead and behind,
// the changed files, the status, the last commit, the last fetch, and the terminal and editor
// actions, or "Remove from project" across the last two columns for a missing member. The
// table owns the focus, the selection, the roving tab stop and the keys; → and ← reach the row's
// own buttons (`useRowActions`), which keep Enter and Space.

import { Code, ListTree, Terminal } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import AheadBehind from "@/components/AheadBehind.vue";
import Checkbox from "@/components/Checkbox.vue";
import DirtyDot from "@/components/DirtyDot.vue";
import IconButton from "@/components/IconButton.vue";
import LaneDot from "@/components/LaneDot.vue";
import { onRowActionsKeydown } from "@/components/useRowActions";
import type { OverviewRow } from "@/stores/overview";

import MemberStatus from "./MemberStatus.vue";
import type { RowStatus } from "./status";

const props = defineProps<{
  row: OverviewRow;
  lane: number;
  selected: boolean;
  focused: boolean;
  tabStop: boolean;
  status: RowStatus | null;
  /** The Fetched column: "1h ago", "never fetched", "fetched with web". */
  fetched: string;
  /** The last commit's time, relative. */
  committed: string;
  outputOpen: boolean;
  /** A missing member can leave the project from its row (a project's, not a folder's). */
  removable: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  focus: [];
  open: [];
  terminal: [];
  editor: [];
  remove: [];
  output: [];
}>();

const { t, n } = useI18n();

const branchText = computed(() => {
  if (props.row.missing) return "—";
  if (props.row.detached) return t("statusBar.detached");
  return props.row.branch ?? "";
});
const changes = computed(() => {
  const changed = props.row.changed;
  if (props.row.missing || changed === null) return "";
  return changed === 0 ? "—" : t("project.files", { n: n(changed) }, changed);
});
/** The lists' count once they are read; the index's flag until then. */
const dirty = computed(() => {
  if (props.row.missing) return false;
  return props.row.changed !== null ? props.row.changed > 0 : props.row.dirty === true;
});
const hasCounts = computed(() => props.row.ahead !== null && props.row.behind !== null);
</script>

<template>
  <div
    role="row"
    :aria-selected="props.selected"
    :tabindex="props.tabStop ? 0 : -1"
    :data-path="props.row.path"
    data-testid="member-row"
    class="member-row grid h-row-list items-center gap-4 border-l-2 px-3 text-md whitespace-nowrap"
    :class="props.focused ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover'"
    @click="emit('focus')"
    @dblclick="emit('open')"
    @keydown="onRowActionsKeydown"
  >
    <span role="gridcell" class="flex items-center" @click.stop>
      <Checkbox
        :model-value="props.selected"
        :focusable="false"
        :aria-label="t('project.select', { name: props.row.name })"
        data-testid="member-select"
        @update:model-value="emit('toggle')"
      />
    </span>
    <span role="gridcell" class="flex min-w-0 items-center gap-2" data-testid="member-name">
      <ListTree
        v-if="props.row.worktree"
        :size="16"
        :stroke-width="1.5"
        class="shrink-0 text-fg-muted"
        :aria-label="t('project.worktree')"
      />
      <span class="truncate" :class="props.row.missing ? 'text-fg-muted' : 'text-fg'">
        {{ props.row.name }}
      </span>
    </span>
    <span
      role="gridcell"
      class="flex min-w-0 items-center gap-2"
      :class="props.row.missing ? 'text-fg-muted' : 'text-fg'"
      data-testid="member-branch"
    >
      <LaneDot v-if="!props.row.missing && props.lane > 0" :lane="props.lane" />
      <span class="truncate">{{ branchText }}</span>
      <DirtyDot v-if="dirty" />
    </span>
    <span role="gridcell" data-testid="member-counts">
      <AheadBehind v-if="hasCounts" :ahead="props.row.ahead ?? 0" :behind="props.row.behind ?? 0" />
      <span v-else-if="!props.row.missing" class="text-sm text-fg-muted">—</span>
    </span>
    <span role="gridcell" class="truncate text-sm text-fg-secondary" data-testid="member-changes">
      {{ changes }}
    </span>
    <!-- The status may run 8px into the column gap, as "Diverged from its
         upstream" and its link do. -->
    <span
      role="gridcell"
      class="-mr-2 flex min-w-0 items-center gap-2 text-sm"
      data-testid="member-status"
    >
      <MemberStatus
        v-if="props.status"
        :status="props.status"
        :output-open="props.outputOpen"
        @output="emit('output')"
      />
    </span>
    <span
      role="gridcell"
      class="flex min-w-0 items-center gap-2 text-sm text-fg-muted"
      data-testid="member-commit"
    >
      <span class="truncate">{{ props.row.lastCommitSubject ?? "" }}</span>
      <span class="shrink-0">{{ props.committed }}</span>
    </span>
    <span v-if="props.row.missing" role="gridcell" class="member-wide flex justify-end">
      <button
        v-if="props.removable"
        type="button"
        tabindex="-1"
        data-row-action
        class="h-5 rounded-sm px-3 text-sm text-fg-secondary hover:bg-hover hover:text-fg"
        data-testid="member-remove"
        @click.stop="emit('remove')"
      >
        {{ t("project.removeFromProject") }}
      </button>
    </span>
    <template v-else>
      <span role="gridcell" class="truncate text-sm text-fg-muted" data-testid="member-fetched">
        {{ props.fetched }}
      </span>
      <span role="gridcell" class="flex items-center justify-end gap-1">
        <IconButton
          :label="t('project.terminal', { name: props.row.name })"
          :icon="Terminal"
          tabindex="-1"
          data-row-action
          data-testid="member-terminal"
          @click.stop="emit('terminal')"
        />
        <IconButton
          :label="t('project.editor', { name: props.row.name })"
          :icon="Code"
          tabindex="-1"
          data-row-action
          data-testid="member-editor"
          @click.stop="emit('editor')"
        />
      </span>
    </template>
  </div>
</template>

<style scoped>
/* select 14, name 180, branch 180, ahead 64, changes 64, status 200, last commit, fetched 80,
   actions 52. */
.member-row {
  grid-template-columns: 14px 180px 180px 64px 64px 200px minmax(0, 1fr) 80px 52px;
}
/* A missing member's "Remove from project" takes the Fetched and actions columns. */
.member-wide {
  grid-column: span 2;
}
</style>
