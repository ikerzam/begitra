<script setup lang="ts">
// The picker of refs and commits: the 640px overlay
// of the palette with a title, the input, the grouped rows with a lane-coloured icon and a
// muted context, the range chips, the footer hints; ↑↓ move, ↵ chooses, Tab switches the
// dots of a typed range, esc closes.

import {
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  ListTree,
  Search,
  Tag,
  Terminal,
  X,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";

import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import Kbd from "@/components/Kbd.vue";
import { laneTextClass } from "@/components/lanes";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { useFocusTrap } from "@/components/useFocusTrap";
import { branchLanes } from "@/shell/branchLanes";
import { errorText } from "@/shell/errorMessage";
import { relativeDate } from "@/shell/format";
import { useExternal } from "@/shell/useExternal";
import { useNow } from "@/shell/useNow";
import { usePickerStore } from "@/stores/picker";
import { useRepoStore } from "@/stores/repo";

import {
  parseRange,
  pickerRows,
  toggleDots,
  type PickerRow,
  type PickerSection,
} from "./usePicker";

const { t } = useI18n();
const picker = usePickerStore();
const repo = useRepoStore();
const external = useExternal();
const now = useNow();

const query = ref("");
const cursor = ref(0);
const input = ref<{ $el: HTMLElement } | null>(null);
const list = ref<HTMLElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
const trap = useFocusTrap(dialog);

const title = computed(() => {
  const mode = picker.mode;
  if (!mode) return "";
  if (mode.kind === "diff-from") return t("picker.diffFrom");
  if (mode.kind === "branch-action") {
    const branch = repo.currentBranch?.name ?? "HEAD";
    switch (mode.action) {
      case "checkout":
        return t("picker.checkout");
      case "merge":
        return t("picker.mergeInto", { branch });
      case "rebase":
        return t("picker.rebaseOnto", { branch });
      case "create":
        return t("picker.createFrom");
    }
  }
  return t("picker.compareWith", { subject: mode.other.label });
});
/** Ranges make no sense for a comparison side or a branch action: refs and commits only. */
const compareMode = computed(() => picker.mode?.kind !== "diff-from");

function ago(seconds: number): string {
  const rel = relativeDate(seconds, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
}

const rows = computed(() =>
  pickerRows({
    query: query.value,
    refs: repo.refs,
    worktrees: repo.worktrees,
    commits: repo.commits,
    lanes: branchLanes(repo.refs),
    ago,
    words: { current: t("picker.current"), worktree: t("picker.worktreeAt") },
    ranges: !compareMode.value,
  }),
);

const sectionLabels: Record<PickerSection, string> = {
  range: t("picker.range"),
  endpoints: t("picker.endpoints"),
  branches: t("picker.branches"),
  tags: t("picker.tags"),
  worktrees: t("picker.worktrees"),
  commits: t("picker.recentCommits"),
};

const sections = computed(() => {
  const order: PickerSection[] = ["range", "endpoints", "branches", "tags", "worktrees", "commits"];
  let offset = 0;
  return order
    .map((id) => {
      const sectionRows = rows.value.filter((row) => row.section === id);
      const section = { id, label: sectionLabels[id], rows: sectionRows, offset };
      offset += sectionRows.length;
      return section;
    })
    .filter((section) => section.rows.length > 0);
});

const range = computed(() => (compareMode.value ? null : parseRange(query.value)));
const loading = computed(() => repo.state.kind === "ready" && !repo.refsLoaded);
const refsError = computed(() => repo.refsError);
const refsErrorMessage = computed(() => {
  if (!refsError.value) return "";
  const text = errorText(refsError.value);
  return t("picker.refsFailed", { message: t(text.key, text.params) });
});
const isEmpty = computed(() => !loading.value && rows.value.length === 0);

const icons: Record<PickerSection, Component> = {
  range: GitCompare,
  endpoints: GitBranch,
  branches: GitBranch,
  tags: Tag,
  worktrees: ListTree,
  commits: GitCommitHorizontal,
};

function iconOf(row: PickerRow): Component {
  if (row.section === "endpoints") {
    return row.kind === "tag" ? Tag : row.kind === "commit" ? GitCommitHorizontal : GitBranch;
  }
  return icons[row.section];
}

function optionId(index: number): string {
  return `picker-option-${index}`;
}

watch(rows, () => {
  cursor.value = 0;
});

function move(step: number): void {
  const count = rows.value.length;
  if (count === 0) return;
  cursor.value = (((cursor.value + step) % count) + count) % count;
}

function chooseCurrent(): void {
  const row = rows.value[cursor.value];
  if (row) void picker.choose(row.choice);
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      move(-1);
      break;
    case "Home":
      event.preventDefault();
      cursor.value = 0;
      break;
    case "End":
      event.preventDefault();
      cursor.value = Math.max(0, rows.value.length - 1);
      break;
    case "Enter":
      event.preventDefault();
      chooseCurrent();
      break;
    case "Tab":
      if (range.value) {
        event.preventDefault();
        query.value = toggleDots(query.value);
      }
      break;
    case "Escape":
      event.preventDefault();
      picker.close();
      break;
  }
}

let previouslyFocused: Element | null = null;

onMounted(() => {
  previouslyFocused = document.activeElement;
  void nextTick(() => input.value?.$el.querySelector("input")?.focus());
});

onBeforeUnmount(() => {
  const previous = previouslyFocused;
  const active = document.activeElement;
  const still = active === null || active === document.body || dialog.value?.contains(active);
  if (previous instanceof HTMLElement && previous.isConnected && still) previous.focus();
});

watch(cursor, (index) => {
  list.value?.querySelector(`[data-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" });
});
</script>

<template>
  <div
    class="absolute inset-0 z-40 flex justify-center"
    data-testid="picker-overlay"
    @click.self="picker.close()"
  >
    <div
      ref="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      class="picker flex max-h-full flex-col rounded-lg border border-line-strong bg-raised shadow-overlay"
      @keydown="trap.onKeydown"
    >
      <div class="flex items-center justify-between gap-3 px-3 pt-3">
        <h2 class="text-md font-semibold text-fg" data-testid="picker-title">{{ title }}</h2>
        <IconButton :label="t('picker.close')" :icon="X" @click="picker.close()" />
      </div>
      <div class="px-3 py-2">
        <Input
          ref="input"
          v-model="query"
          :icon="Search"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="picker-list"
          :aria-expanded="rows.length > 0"
          :aria-activedescendant="rows.length > 0 ? optionId(cursor) : undefined"
          :placeholder="t('picker.placeholder')"
          data-testid="picker-input"
          @keydown="onKeydown"
        />
      </div>
      <div v-if="range" class="flex items-center gap-3 px-3 py-2" data-testid="picker-chips">
        <button
          type="button"
          class="h-control rounded-md px-3 text-md font-medium"
          :class="range.threeDot ? 'text-fg-secondary hover:bg-hover' : 'bg-selected text-fg'"
          @click="range.threeDot && (query = toggleDots(query))"
        >
          A..B
        </button>
        <button
          type="button"
          class="h-control rounded-md px-3 text-md font-medium"
          :class="range.threeDot ? 'bg-selected text-fg' : 'text-fg-secondary hover:bg-hover'"
          @click="!range.threeDot && (query = toggleDots(query))"
        >
          A...B
        </button>
        <span class="text-sm text-fg-muted">{{ t("picker.rangeHelp") }}</span>
      </div>
      <div
        id="picker-list"
        ref="list"
        role="listbox"
        class="min-h-0 flex-1 overflow-y-auto p-1"
        data-testid="picker-list"
      >
        <div v-if="refsError" class="p-2" data-testid="picker-error">
          <ErrorBanner
            :message="refsErrorMessage"
            :output="refsError.detail"
            :action="t('palette.commandsById.open-terminal')"
            :action-icon="Terminal"
            @action="() => void external.openTerminal()"
          />
        </div>
        <template v-else-if="loading">
          <SkeletonRow v-for="n in 6" :key="n" :index="n" height="list" />
        </template>
        <template v-for="section in sections" :key="section.id">
          <p class="picker-section text-sm text-fg-muted" role="presentation">
            {{ section.label }}
          </p>
          <div
            v-for="(row, index) in section.rows"
            :id="optionId(section.offset + index)"
            :key="row.key"
            role="option"
            :aria-selected="cursor === section.offset + index"
            :data-index="section.offset + index"
            class="flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-md text-fg"
            :class="cursor === section.offset + index ? 'bg-selected' : 'hover:bg-hover'"
            data-testid="picker-row"
            @mousemove="cursor = section.offset + index"
            @click="() => void picker.choose(row.choice)"
          >
            <component
              :is="iconOf(row)"
              :size="16"
              :stroke-width="1.5"
              aria-hidden="true"
              class="shrink-0"
              :class="row.lane > 0 ? laneTextClass(row.lane) : 'text-fg-secondary'"
            />
            <span class="flex-1 truncate">{{ row.label }}</span>
            <span v-if="row.context" class="truncate text-sm text-fg-muted">{{ row.context }}</span>
          </div>
        </template>
        <p
          v-if="isEmpty && !refsError"
          class="picker-empty flex items-center justify-center px-3 text-center text-md text-fg-secondary"
          data-testid="picker-empty"
        >
          {{ t("picker.empty", { query: query.trim() }) }}
        </p>
      </div>
      <div
        class="flex h-panel-header shrink-0 items-center gap-3 border-t border-line px-3 text-sm text-fg-muted"
      >
        <span class="flex items-center gap-2"><Kbd keys="↑↓" /> {{ t("palette.move") }}</span>
        <span class="flex items-center gap-2"><Kbd keys="↵" /> {{ t("picker.choose") }}</span>
        <span v-if="range" class="flex items-center gap-2"
          ><Kbd keys="tab" /> {{ t("picker.switchDots") }}</span
        >
        <span class="flex items-center gap-2"><Kbd keys="esc" /> {{ t("picker.closeHint") }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The palette's 640px overlay, 80px from the top; off the spacing scale. */
.picker {
  width: 640px;
  margin-top: 80px;
  max-height: calc(100% - 160px);
}

.picker-section {
  padding: var(--space-2) var(--space-2) 2px;
}

/* The empty sentence is centred in the same 135px area as the palette's. */
.picker-empty {
  height: 135px;
}
</style>
