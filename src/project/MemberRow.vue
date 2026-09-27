<script setup lang="ts">
// One member of the project Overview: the checkbox, the name (with the worktree
// icon for a linked worktree), the branch with its lane dot and dirty dot, ahead and behind,
// the changed files, the status, the last commit, the last fetch, and the terminal and editor
// actions, or "Remove from project" for a missing member. The Overview owns the focus, the
// selection, the roving tab stop and the keys.

import { CircleAlert, CircleCheck, CircleMinus, Code, ListTree, Terminal } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import AheadBehind from "@/components/AheadBehind.vue";
import Checkbox from "@/components/Checkbox.vue";
import DirtyDot from "@/components/DirtyDot.vue";
import IconButton from "@/components/IconButton.vue";
import LaneDot from "@/components/LaneDot.vue";
import Progress from "@/components/Progress.vue";
import type { OverviewRow } from "@/stores/overview";

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
  /** Whether the output of the status shows under the row. */
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

const icons = { check: CircleCheck, minus: CircleMinus, alert: CircleAlert } as const;
const tones = {
  fg: "text-fg",
  muted: "text-fg-muted",
  warn: "text-warn",
  danger: "text-danger",
} as const;
const iconTones = {
  fg: "text-ok",
  muted: "text-fg-muted",
  warn: "text-warn",
  danger: "text-danger",
} as const;

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
const dirty = computed(
  () => !props.row.missing && (props.row.dirty === true || (props.row.changed ?? 0) > 0),
);
const hasCounts = computed(() => props.row.ahead !== null && props.row.behind !== null);
</script>

<template>
  <div
    role="row"
    :aria-selected="props.focused"
    :tabindex="props.tabStop ? 0 : -1"
    :data-path="props.row.path"
    data-testid="member-row"
    class="member-row grid h-row-list items-center gap-4 border-l-2 px-3 text-md whitespace-nowrap"
    :class="props.focused ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover'"
    @click="emit('focus')"
    @dblclick="emit('open')"
  >
    <span role="gridcell" class="flex items-center" @click.stop>
      <Checkbox
        :model-value="props.selected"
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
    <span
      role="gridcell"
      class="flex min-w-0 items-center gap-2 text-sm"
      data-testid="member-status"
    >
      <template v-if="props.status">
        <component
          :is="icons[props.status.icon]"
          v-if="props.status.icon"
          :size="16"
          :stroke-width="1.5"
          aria-hidden="true"
          class="shrink-0"
          :class="iconTones[props.status.tone]"
        />
        <span class="truncate" :class="tones[props.status.tone]">{{ props.status.text }}</span>
        <Progress
          v-if="props.status.progress !== undefined"
          class="w-12 shrink-0"
          :value="props.status.progress ?? 0"
          :indeterminate="props.status.progress === null"
        />
        <button
          v-if="props.status.output"
          type="button"
          class="shrink-0 text-accent hover:underline"
          :aria-expanded="props.outputOpen"
          data-testid="member-output-toggle"
          @click.stop="emit('output')"
        >
          {{ props.outputOpen ? t("project.hideOutput") : t("project.showOutput") }}
        </button>
      </template>
    </span>
    <span
      role="gridcell"
      class="flex min-w-0 items-center gap-2 text-sm text-fg-muted"
      data-testid="member-commit"
    >
      <span class="truncate">{{ props.row.lastCommitSubject ?? "" }}</span>
      <span class="shrink-0">{{ props.committed }}</span>
    </span>
    <span role="gridcell" class="truncate text-sm text-fg-muted" data-testid="member-fetched">
      {{ props.fetched }}
    </span>
    <span role="gridcell" class="flex items-center justify-end gap-1">
      <button
        v-if="props.row.missing && props.removable"
        type="button"
        class="text-sm text-fg hover:underline"
        data-testid="member-remove"
        @click.stop="emit('remove')"
      >
        {{ t("project.removeFromProject") }}
      </button>
      <template v-else-if="!props.row.missing">
        <IconButton
          :label="t('project.terminal', { name: props.row.name })"
          :icon="Terminal"
          tabindex="-1"
          data-testid="member-terminal"
          @click.stop="emit('terminal')"
        />
        <IconButton
          :label="t('project.editor', { name: props.row.name })"
          :icon="Code"
          tabindex="-1"
          data-testid="member-editor"
          @click.stop="emit('editor')"
        />
      </template>
    </span>
  </div>
</template>

<style scoped>
/* select 14, name 180, branch 180, ahead 64, changes 64, status 200, last commit, fetched 80,
   actions 136. */
.member-row {
  grid-template-columns: 14px 180px 180px 64px 64px 200px minmax(0, 1fr) 80px 136px;
}
</style>
