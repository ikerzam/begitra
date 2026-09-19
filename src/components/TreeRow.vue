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
    reviewed?: boolean;
    selected?: boolean;
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
    reviewed: false,
    selected: false,
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
</script>

<template>
  <div
    role="treeitem"
    :aria-selected="props.selected"
    :aria-expanded="isFolder ? props.expanded : undefined"
    :aria-level="props.depth + 1"
    :tabindex="props.selected ? 0 : -1"
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
    <DiffStat v-if="hasStats" :added="props.added ?? 0" :removed="props.removed ?? 0" />
    <Check
      v-if="props.reviewed"
      :size="16"
      :stroke-width="1.5"
      role="img"
      :aria-label="t('treeRow.reviewed')"
      class="shrink-0 text-reviewed"
    />
  </div>
</template>
