<script setup lang="ts">
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
    selected?: boolean;
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
    selected: false,
  },
);

const emit = defineEmits<{ select: []; activate: [] }>();

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
    data-testid="repo-row"
    class="repo-row grid h-row-list items-center gap-4 border-l-2 px-3 text-md whitespace-nowrap"
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
        class="mr-2 ml-2 inline-block size-3 shrink-0 border-b border-l border-line-strong"
      />
      <span class="truncate text-fg">{{ props.name }}</span>
    </span>
    <span class="flex items-center gap-2 overflow-hidden" data-testid="repo-row-branch">
      <LaneDot v-if="props.lane > 0" :lane="props.lane" />
      <span class="truncate text-fg">{{ props.branch }}</span>
      <DirtyDot v-if="props.dirty" />
    </span>
    <AheadBehind :ahead="props.ahead" :behind="props.behind" />
    <span class="truncate text-sm text-fg-muted" data-testid="repo-row-last-commit">
      {{ props.lastCommit }}
    </span>
    <span class="truncate font-mono text-mono-sm text-fg-muted" data-testid="repo-row-path">
      {{ props.path }}
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
