<script setup lang="ts">
// The checklist of the indexed repositories and worktrees, grouped as Home groups
// them (one group per scan folder, its path in mono, then the ones opened on their own),
// worktrees indented under their repository, narrowed by `query` (name or path). The model
// holds the checked paths in the list's order, the order a new project keeps. One tab stop:
// ↑↓ and j/k move the focus between the boxes, Space checks the focused one.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import { tableSections, type TableSection } from "@/discovery/sections";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { sameFolder } from "@/shell/format";
import { rowStep } from "@/shortcuts/useListNavigation";
import { useIndexStore } from "@/stores/index";

const props = withDefaults(
  defineProps<{
    /** Text that narrows the list, matched against the name and the path. */
    query?: string;
    /** Paths left out (a project's members already). */
    exclude?: string[];
  }>(),
  { query: "", exclude: () => [] },
);
const checked = defineModel<string[]>({ default: () => [] });

const { t } = useI18n();
const index = useIndexStore();
const format = useDiscoveryFormat();

const sections = computed<TableSection[]>(() =>
  tableSections({
    pinned: [],
    recent: [],
    all: [...index.mains].sort(
      (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
    ),
    scanRoots: index.scanRoots,
    worktreesOf: index.worktreesOf,
  }),
);

const excluded = (path: string) => props.exclude.some((known) => sameFolder(known, path));

/** The sections with the rows that are not excluded and match the query. */
const shown = computed(() => {
  const words = props.query.trim().toLowerCase();
  return sections.value
    .map((section) => ({
      ...section,
      rows: section.rows.filter(
        (row) =>
          !row.entry.missing &&
          !excluded(row.entry.path) &&
          (words === "" ||
            row.entry.name.toLowerCase().includes(words) ||
            row.entry.path.toLowerCase().includes(words)),
      ),
    }))
    .filter((section) => section.rows.length > 0);
});

/** The shown paths in the list's order. */
const flat = computed(() =>
  shown.value.flatMap((section) => section.rows.map((row) => row.entry.path)),
);
const list = ref<HTMLElement | null>(null);
const focusedPath = ref<string | null>(null);
/** The list's tab stop: the focused box while it is shown, else the first. */
const stopPath = computed(() =>
  focusedPath.value !== null && flat.value.includes(focusedPath.value)
    ? focusedPath.value
    : (flat.value[0] ?? null),
);

function onFocusin(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const path = target.closest<HTMLElement>("[data-path]")?.dataset.path;
  if (path !== undefined) focusedPath.value = path;
}

function onKeydown(event: KeyboardEvent): void {
  const step = rowStep(event);
  if (step === 0) return;
  event.preventDefault();
  const at = stopPath.value === null ? -1 : flat.value.indexOf(stopPath.value);
  const next = Math.max(0, Math.min(at + step, flat.value.length - 1));
  const path = flat.value[next];
  if (path === undefined) return;
  focusedPath.value = path;
  list.value?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[next]?.focus();
}

/** Every listed path in the list's order, whatever the query hides. */
const order = computed(() =>
  sections.value.flatMap((section) => section.rows.map((row) => row.entry.path)),
);

function label(section: TableSection): string {
  return section.folder === null ? t("home.sections.other") : format.displayPath(section.folder);
}

function toggle(path: string, on: boolean): void {
  const next = new Set(checked.value);
  if (on) next.add(path);
  else next.delete(path);
  // Checked paths the list no longer shows (added by hand before the index knew them) go last.
  const ordered = order.value.filter((known) => next.has(known));
  const rest = [...next].filter((known) => !ordered.includes(known));
  checked.value = [...ordered, ...rest];
}
</script>

<template>
  <div
    ref="list"
    class="checklist flex flex-col overflow-y-auto rounded-md border border-line px-3 py-1"
    data-testid="repository-checklist"
    @focusin="onFocusin"
    @keydown="onKeydown"
  >
    <template v-for="section in shown" :key="section.id">
      <p
        class="pt-2 pb-1 text-sm text-fg-muted"
        :class="section.folder === null ? '' : 'font-mono text-mono-sm'"
      >
        {{ label(section) }}
      </p>
      <Checkbox
        v-for="row in section.rows"
        :key="row.key"
        class="h-control shrink-0"
        :class="row.nested ? 'pl-5' : ''"
        :label="row.entry.name"
        :model-value="checked.includes(row.entry.path)"
        :focusable="row.entry.path === stopPath"
        :data-path="row.entry.path"
        data-testid="checklist-item"
        @update:model-value="(on) => toggle(row.entry.path, on)"
      />
    </template>
    <p v-if="shown.length === 0" class="py-2 text-sm text-fg-muted" data-testid="checklist-empty">
      {{ t("project.checklistEmpty") }}
    </p>
  </div>
</template>

<style scoped>
/* About eight rows, then the list scrolls. */
.checklist {
  max-height: 360px;
}
</style>
