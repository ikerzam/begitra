<script setup lang="ts">
// The stash sheet: the message field, "Include untracked" and "Stash N
// changes" in the header row; every stash with its badge, message and date, "Apply", "Pop"
// and the drop control (confirmed once); the footer sentence. The rows are a grid with one
// roving tab stop: j/k and the arrows move, ↵ applies, → reaches the row's buttons.

import { Archive, Trash2 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Checkbox from "@/components/Checkbox.vue";
import Dialog from "@/components/Dialog.vue";
import EmptyState from "@/components/EmptyState.vue";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import RefBadge from "@/components/RefBadge.vue";
import Sheet from "@/components/Sheet.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { onRowActionsKeydown } from "@/components/useRowActions";
import { relativeDate } from "@/shell/format";
import { useNow } from "@/shell/useNow";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useChangesStore } from "@/stores/changes";
import { useRepoStore } from "@/stores/repo";
import { useStashStore } from "@/stores/stash";

const { t, n } = useI18n();
const stash = useStashStore();
const changes = useChangesStore();
const repo = useRepoStore();
const now = useNow();

const message = ref("");
const includeUntracked = ref(false);
const grid = ref<HTMLElement | null>(null);
const selected = ref(0);
const busy = computed(() => stash.busy !== null);
/** What "Stash N changes" counts: the files of both lists when the changes screen has them. */
const changeCount = computed(() => changes.unstagedCount + changes.stagedCount);
const stashLabel = computed(() =>
  changes.loaded && changeCount.value > 0
    ? t("stash.stashChanges", { n: n(changeCount.value) }, changeCount.value)
    : t("stash.stashNow"),
);
const rowCount = computed(() => stash.stashes.length);
const tabStop = computed(() => Math.min(Math.max(0, selected.value), rowCount.value - 1));

const navigation = useListNavigation({
  count: rowCount,
  selected,
  onActivate: (index) => {
    const row = stash.stashes[index];
    if (row && !busy.value) void stash.apply(row);
  },
  rowElement: (index) => grid.value?.querySelector(`[data-index="${index}"]`),
});

/** Enter on a row's button is the button's click, not the row's apply. */
function onGridKeydown(event: KeyboardEvent): void {
  const onButton =
    event.key === "Enter" &&
    event.target instanceof HTMLElement &&
    !event.target.matches('[role="row"]');
  if (!onButton) navigation.onKeydown(event);
}

function ago(seconds: number): string {
  const rel = relativeDate(seconds, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
}

async function push(): Promise<void> {
  const text = message.value.trim();
  if (await stash.push(text === "" ? null : text, includeUntracked.value)) message.value = "";
}

function confirmDrop(): void {
  const row = stash.dropPrompt;
  if (row !== null) void stash.drop(row);
}
</script>

<template>
  <Sheet
    :title="t('stash.title')"
    :count="repo.refsLoaded ? stash.stashes.length : undefined"
    :footer="t('stash.footer')"
    close-as="icon"
    data-testid="stash-sheet"
    @close="stash.closeSheet()"
  >
    <form
      class="flex items-center gap-3 border-b border-line px-5 py-3"
      data-testid="stash-push-form"
      @submit.prevent="() => void push()"
    >
      <Input
        v-model="message"
        :placeholder="t('stash.messagePlaceholder')"
        :icon="Archive"
        data-autofocus
        data-testid="stash-message"
      />
      <Checkbox
        v-model="includeUntracked"
        class="shrink-0 whitespace-nowrap"
        :label="t('stash.includeUntracked')"
        data-testid="stash-untracked"
      />
      <Button type="submit" variant="primary" :disabled="busy" data-testid="stash-push">
        {{ stashLabel }}
      </Button>
    </form>
    <div v-if="!repo.refsLoaded" class="py-2" data-testid="stash-loading">
      <SkeletonRow v-for="k in 2" :key="k" :index="k" height="list" />
    </div>
    <EmptyState
      v-else-if="stash.stashes.length === 0"
      :message="t('stash.empty')"
      data-testid="stash-empty"
    />
    <div
      v-else
      ref="grid"
      role="grid"
      :aria-label="t('stash.title')"
      class="flex flex-col py-2"
      data-testid="stash-list"
      @keydown="onGridKeydown"
    >
      <div
        v-for="(row, index) in stash.stashes"
        :key="row.name"
        role="row"
        :data-index="index"
        :tabindex="index === tabStop ? 0 : -1"
        class="sheet-row flex items-center gap-3 px-5 hover:bg-hover"
        :class="{ 'bg-selected': index === selected }"
        :aria-selected="index === selected ? 'true' : 'false'"
        :data-stash="row.index"
        @focus="selected = index"
        @click="selected = index"
        @keydown="onRowActionsKeydown"
      >
        <span role="gridcell" class="flex min-w-0 flex-1 items-center gap-3">
          <RefBadge :label="row.name" kind="stash" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-md text-fg" data-testid="stash-row-message">{{
              row.message
            }}</span>
            <span
              v-if="row.time !== null"
              class="text-sm text-fg-muted"
              data-testid="stash-row-date"
            >
              {{ ago(row.time) }}
            </span>
          </span>
        </span>
        <span role="gridcell" class="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            :disabled="busy"
            tabindex="-1"
            data-row-action
            data-testid="stash-apply"
            @click="() => void stash.apply(row)"
          >
            {{ t("stash.apply") }}
          </Button>
          <Button
            variant="ghost"
            :disabled="busy"
            tabindex="-1"
            data-row-action
            data-testid="stash-pop"
            @click="() => void stash.pop(row)"
          >
            {{ t("stash.pop") }}
          </Button>
          <IconButton
            :label="t('stash.drop')"
            :icon="Trash2"
            :disabled="busy"
            tabindex="-1"
            data-row-action
            data-testid="stash-drop"
            @click="stash.askDrop(row)"
          />
        </span>
      </div>
    </div>
    <Dialog
      v-if="stash.dropPrompt !== null"
      :title="t('stash.dropTitle', { name: stash.dropPrompt.name })"
      :body="t('stash.dropBody')"
      :confirm-label="t('stash.dropConfirm')"
      variant="destructive"
      data-testid="stash-drop-dialog"
      @confirm="confirmDrop"
      @cancel="stash.dismissDrop()"
    />
  </Sheet>
</template>

<style scoped>
/* A row is 48px (the message and its date); no row token is 48. */
.sheet-row {
  height: 48px;
}
</style>
