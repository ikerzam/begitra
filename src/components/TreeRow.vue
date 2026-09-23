<script setup lang="ts">
import { Check, ChevronDown, ChevronRight } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import DiffStat from "./DiffStat.vue";
import StatusLetter from "./StatusLetter.vue";
import type { FileStatus } from "./types";

const props = withDefaults(
  defineProps<{
    name: string;
    kind?: "file" | "folder";
    /** Nesting level; each level indents by 16px. */
    depth?: number;
    expanded?: boolean;
    status?: FileStatus;
    added?: number;
    removed?: number;
    /** Files inside a folder. */
    count?: number;
    generated?: boolean;
    /** A binary file: "binary" replaces the line stats. */
    binary?: boolean;
    /** The comparison's preview says this file would conflict: "conflict" before the stats. */
    conflict?: boolean;
    /** Muted text after the name (the kind of a conflict: "both modified"). */
    meta?: string;
    reviewed?: boolean;
    /** Reviewed for another content than the file shows now: the check in `--warn`. */
    changed?: boolean;
    selected?: boolean;
    /** Roving tab stop; defaults to the selected row. Lists without a selection pass it to the first row. */
    tabStop?: boolean;
  }>(),
  {
    kind: "file",
    depth: 0,
    expanded: false,
    status: undefined,
    added: undefined,
    removed: undefined,
    count: undefined,
    generated: false,
    binary: false,
    conflict: false,
    meta: "",
    reviewed: false,
    changed: false,
    selected: false,
    tabStop: undefined,
  },
);

/** `toggle` opens or closes a folder; `activate` opens a file. */
const emit = defineEmits<{ select: []; activate: []; toggle: [] }>();

const { t, n } = useI18n();

const isFolder = computed(() => props.kind === "folder");

const hasStats = computed(
  () =>
    !isFolder.value && !props.binary && (props.added !== undefined || props.removed !== undefined),
);

const indent = computed(() => ({
  paddingLeft: `calc(var(--space-3) + var(--space-4) * ${Math.max(0, props.depth)})`,
}));

/* Generated files dim to the muted colour; folders and reviewed files to the secondary one. */
const nameClass = computed(() => {
  if (props.generated) return "text-fg-muted";
  return isFolder.value || props.reviewed ? "text-fg-secondary" : "text-fg";
});

/* Enter or a double click opens a folder or a file. */
function onActivate(): void {
  if (isFolder.value) emit("toggle");
  else emit("activate");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
    onActivate();
  } else if (isFolder.value && event.key === "ArrowRight" && !props.expanded) {
    event.preventDefault();
    emit("toggle");
  } else if (isFolder.value && event.key === "ArrowLeft" && props.expanded) {
    event.preventDefault();
    emit("toggle");
  }
}

/** What the check says, on hover too: reviewed, or reviewed for another content. */
const checkLabel = computed(() =>
  props.reviewed ? t("treeRow.reviewed") : t("treeRow.changedSinceReview"),
);
</script>

<template>
  <div
    role="treeitem"
    :aria-selected="props.selected"
    :aria-expanded="isFolder ? props.expanded : undefined"
    :aria-level="props.depth + 1"
    :tabindex="(props.tabStop ?? props.selected) ? 0 : -1"
    data-testid="tree-row"
    class="flex h-row-tree items-center gap-2 border-l-2 pr-2 text-md whitespace-nowrap"
    :class="props.selected ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover'"
    :style="indent"
    @click="emit('select')"
    @dblclick="onActivate"
    @keydown="onKeydown"
  >
    <button
      v-if="isFolder"
      type="button"
      tabindex="-1"
      :aria-label="props.expanded ? t('treeRow.collapse') : t('treeRow.expand')"
      data-testid="tree-row-chevron"
      class="flex size-icon shrink-0 items-center justify-center text-fg-secondary"
      @click.stop="emit('toggle')"
    >
      <component
        :is="props.expanded ? ChevronDown : ChevronRight"
        :size="12"
        :stroke-width="1.5"
        aria-hidden="true"
      />
    </button>
    <StatusLetter v-else-if="props.status" :status="props.status" />
    <span class="flex-1 truncate" :class="nameClass" data-testid="tree-row-name">
      {{ props.name }}
    </span>
    <span v-if="props.meta" class="shrink-0 text-sm text-fg-muted" data-testid="tree-row-meta">
      {{ props.meta }}
    </span>
    <span
      v-if="isFolder && props.count !== undefined"
      class="shrink-0 text-sm text-fg-muted"
      data-testid="tree-row-count"
    >
      {{ n(props.count) }}
    </span>
    <span
      v-if="props.generated"
      class="shrink-0 text-sm text-fg-muted"
      data-testid="tree-row-generated"
    >
      {{ t("treeRow.generated") }}
    </span>
    <span
      v-if="props.binary && !isFolder"
      class="shrink-0 text-sm text-fg-muted"
      data-testid="tree-row-binary"
    >
      {{ t("treeRow.binary") }}
    </span>
    <span
      v-if="props.conflict && !isFolder"
      class="shrink-0 text-sm text-danger"
      data-testid="tree-row-conflict"
    >
      {{ t("treeRow.conflict") }}
    </span>
    <span
      v-if="props.changed && !props.reviewed && !isFolder"
      class="shrink-0 text-sm text-warn"
      data-testid="tree-row-changed"
    >
      {{ t("treeRow.changed") }}
    </span>
    <DiffStat v-if="hasStats" :added="props.added ?? 0" :removed="props.removed ?? 0" />
    <span v-if="props.reviewed || props.changed" class="inline-flex shrink-0" :title="checkLabel">
      <Check
        :size="16"
        :stroke-width="1.5"
        role="img"
        :aria-label="checkLabel"
        :class="props.reviewed ? 'text-reviewed' : 'text-warn'"
      />
    </span>
  </div>
</template>
