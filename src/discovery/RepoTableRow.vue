<script setup lang="ts">
// One row of the home table: `RepoRow` fed from an index entry, with the "…" that opens
// the row menu and the right click that opens it at the pointer.

import { Ellipsis } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import RepoRow from "@/components/RepoRow.vue";

import type { TableRow } from "./sections";

const props = defineProps<{
  row: TableRow;
  /** Position in the flat list of rows, for the roving focus. */
  index: number;
  lane: number;
  /** "2h ago", already formatted. */
  lastCommit: string;
  /** The path as displayed (home abbreviated). */
  path: string;
  selected: boolean;
  tabStop: boolean;
}>();

const emit = defineEmits<{ select: []; activate: []; menu: [x: number, y: number] }>();

const { t } = useI18n();

const branch = computed(() => {
  const summary = props.row.entry.summary;
  if (summary.detached) return t("statusBar.detached");
  return summary.currentBranch ?? "";
});

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  emit("menu", event.clientX, event.clientY);
}

function onMore(event: MouseEvent): void {
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  emit("menu", rect.left, rect.bottom + 4);
}
</script>

<template>
  <RepoRow
    :data-index="props.index"
    :data-path="props.row.entry.path"
    :name="props.row.entry.name"
    :branch="branch"
    :lane="props.lane"
    :dirty="props.row.entry.summary.dirty === true"
    :ahead="props.row.entry.summary.ahead ?? 0"
    :behind="props.row.entry.summary.behind ?? 0"
    :last-commit="props.lastCommit"
    :path="props.path"
    :nested="props.row.nested"
    :missing="props.row.entry.missing"
    :selected="props.selected"
    :tab-stop="props.tabStop"
    @select="emit('select')"
    @activate="emit('activate')"
    @contextmenu="onContextMenu"
  >
    <template #actions>
      <IconButton
        :label="t('home.rowActions', { name: props.row.entry.name })"
        :icon="Ellipsis"
        tabindex="-1"
        data-testid="repo-row-more"
        @click="onMore"
      />
    </template>
  </RepoRow>
</template>
