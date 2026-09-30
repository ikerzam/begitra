<script setup lang="ts">
// The checklist of the indexed repositories and worktrees, grouped by project (each
// listed once, under the first project by name that holds it; a folder project's folder in
// mono), worktrees indented under their repository, then the ones "Add repository…" described
// and the index does not hold yet, narrowed by `query` (name or path). The model holds the
// checked paths in the list's order, the order a new project keeps. One tab stop: ↑↓ and j/k
// move the focus between the boxes, Space checks the focused one.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import type { IndexEntry } from "@/ipc/schemas";
import { folderKey, sameFolder } from "@/shell/format";
import { rowStep } from "@/shortcuts/useListNavigation";
import { useProjectsStore } from "@/stores/projects";

const props = withDefaults(
  defineProps<{
    /** Text that narrows the list, matched against the name and the path. */
    query?: string;
    /** Paths left out (a project's members already). */
    exclude?: string[];
    /** Repositories described by "Add repository…" that the index does not hold yet. */
    added?: IndexEntry[];
  }>(),
  { query: "", exclude: () => [], added: () => [] },
);
const checked = defineModel<string[]>({ default: () => [] });

const { t } = useI18n();
const projects = useProjectsStore();
const format = useDiscoveryFormat();

interface ChecklistRow {
  path: string;
  name: string;
  nested: boolean;
}

interface ChecklistGroup {
  key: string;
  label: string;
  mono: boolean;
  rows: ChecklistRow[];
}

/** Every group with its rows, each repository once, before the query narrows them. */
const groups = computed<ChecklistGroup[]>(() => {
  const seen = new Set<string>();
  const list: ChecklistGroup[] = [];
  for (const project of projects.sorted) {
    const rows: ChecklistRow[] = [];
    for (const member of projects.members(project)) {
      const key = folderKey(member.path);
      if (member.missing || seen.has(key)) continue;
      seen.add(key);
      rows.push({ path: member.path, name: member.name, nested: member.nested });
    }
    if (rows.length === 0) continue;
    list.push({
      key: `project:${project.id}`,
      label: project.folder === null ? project.name : format.displayPath(project.folder),
      mono: project.folder !== null,
      rows,
    });
  }
  const added = props.added
    .filter((entry) => !seen.has(folderKey(entry.path)))
    .map((entry) => ({ path: entry.path, name: entry.name, nested: false }));
  if (added.length > 0) {
    list.push({ key: "added", label: t("project.new.added"), mono: false, rows: added });
  }
  return list;
});

const excluded = (path: string) => props.exclude.some((known) => sameFolder(known, path));

/** The groups with the rows that are not excluded and match the query. */
const shown = computed(() => {
  const words = props.query.trim().toLowerCase();
  return groups.value
    .map((group) => ({
      ...group,
      rows: group.rows.filter(
        (row) =>
          !excluded(row.path) &&
          (words === "" ||
            row.name.toLowerCase().includes(words) ||
            row.path.toLowerCase().includes(words)),
      ),
    }))
    .filter((group) => group.rows.length > 0);
});

/** The shown paths in the list's order. */
const flat = computed(() => shown.value.flatMap((group) => group.rows.map((row) => row.path)));
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
const order = computed(() => groups.value.flatMap((group) => group.rows.map((row) => row.path)));

function toggle(path: string, on: boolean): void {
  const next = new Set(checked.value);
  if (on) next.add(path);
  else next.delete(path);
  // Checked paths the list does not show go last.
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
    <template v-for="group in shown" :key="group.key">
      <p
        class="pt-2 pb-1 text-sm text-fg-muted"
        :class="group.mono ? 'font-mono text-mono-sm' : ''"
        data-testid="checklist-group"
      >
        {{ group.label }}
      </p>
      <Checkbox
        v-for="row in group.rows"
        :key="row.path"
        class="h-control shrink-0"
        :class="row.nested ? 'pl-5' : ''"
        :label="row.name"
        :model-value="checked.includes(row.path)"
        :focusable="row.path === stopPath"
        :data-path="row.path"
        data-testid="checklist-item"
        @update:model-value="(on) => toggle(row.path, on)"
      />
    </template>
    <p v-if="shown.length === 0" class="py-2 text-sm text-fg-muted" data-testid="checklist-empty">
      {{ props.query.trim() ? t("project.checklistEmpty") : t("project.checklistNothing") }}
    </p>
  </div>
</template>

<style scoped>
/* About eight rows, then the list scrolls. */
.checklist {
  max-height: 360px;
}
</style>
