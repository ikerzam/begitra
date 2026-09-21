<script setup lang="ts">
// The remotes sheet: every remote with its URL, "Fetch" and "Fetch and prune"
// per row and the remove control, "Fetch all" and "Add remote" (an inline name and URL form)
// in the header, the footer sentence and "Close". Removing confirms once. The rows are a
// grid with one roving tab stop: j/k and the arrows move, ↵ fetches, → reaches the row's
// buttons.

import { Cloud, Plus, RefreshCw, Trash2 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import Sheet from "@/components/Sheet.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { onRowActionsKeydown } from "@/components/useRowActions";
import { errorText } from "@/shell/errorMessage";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useRemotesStore } from "@/stores/remotes";

import { validName } from "@/branches/names";

const { t } = useI18n();
const remotes = useRemotesStore();

const adding = ref(false);
const name = ref("");
const url = ref("");
const grid = ref<HTMLElement | null>(null);
const selected = ref(0);
const busy = computed(() => remotes.busy !== null || remotes.inFlight !== null);
const canAdd = computed(
  () =>
    validName(name.value) &&
    url.value.trim() !== "" &&
    !url.value.trim().startsWith("-") &&
    !remotes.remotes.some((remote) => remote.name === name.value.trim()),
);
const removing = computed(() =>
  remotes.prompt?.kind === "removeRemote" ? remotes.prompt.name : null,
);
const rowCount = computed(() => remotes.remotes.length);
const tabStop = computed(() => Math.min(Math.max(0, selected.value), rowCount.value - 1));
const failure = computed(() => {
  const error = remotes.loadError;
  if (!error) return null;
  const text = errorText(error);
  return {
    message: t("remotes.loadFailed", { message: t(text.key, text.params) }),
    output: error.detail ?? error.message,
  };
});

const navigation = useListNavigation({
  count: rowCount,
  selected,
  onActivate: (index) => {
    const remote = remotes.remotes[index];
    if (remote && !busy.value) void remotes.fetch(remote.name, false);
  },
  rowElement: (index) => grid.value?.querySelector(`[data-index="${index}"]`),
});

/** Enter on a row's button is the button's click, not the row's fetch. */
function onGridKeydown(event: KeyboardEvent): void {
  const onButton =
    event.key === "Enter" &&
    event.target instanceof HTMLElement &&
    !event.target.matches('[role="row"]');
  if (!onButton) navigation.onKeydown(event);
}

async function add(): Promise<void> {
  if (!canAdd.value) return;
  if (await remotes.add(name.value.trim(), url.value.trim())) {
    adding.value = false;
    name.value = "";
    url.value = "";
  }
}

function confirmRemove(): void {
  const target = removing.value;
  if (target) void remotes.remove(target);
}
</script>

<template>
  <Sheet
    :title="t('remotes.title')"
    :count="remotes.loading || remotes.loadError ? undefined : remotes.remotes.length"
    :footer="t('remotes.footer')"
    data-testid="remotes-sheet"
    @close="remotes.closeSheet()"
  >
    <template #actions>
      <Button
        variant="ghost"
        :icon="RefreshCw"
        :disabled="busy || remotes.remotes.length === 0"
        data-testid="remotes-fetch-all"
        @click="() => void remotes.fetch(null, false)"
      >
        {{ t("remotes.fetchAll") }}
      </Button>
      <Button variant="secondary" :icon="Plus" data-testid="remotes-add" @click="adding = !adding">
        {{ t("remotes.addRemote") }}
      </Button>
    </template>
    <form
      v-if="adding"
      class="flex items-center gap-3 border-b border-line px-5 py-3"
      data-testid="remotes-add-form"
      @submit.prevent="() => void add()"
    >
      <Input
        v-model="name"
        class="remote-name"
        :placeholder="t('remotes.namePlaceholder')"
        data-autofocus
        data-testid="remote-name"
      />
      <Input v-model="url" :placeholder="t('remotes.urlPlaceholder')" data-testid="remote-url" />
      <Button
        type="submit"
        variant="primary"
        :disabled="!canAdd || busy"
        data-testid="remote-add-confirm"
      >
        {{ t("remotes.add") }}
      </Button>
      <Button variant="ghost" @click="adding = false">{{ t("remotes.cancel") }}</Button>
    </form>
    <template v-if="remotes.loading && remotes.remotes.length === 0">
      <div class="py-2">
        <SkeletonRow v-for="k in 2" :key="k" :index="k" height="list" />
      </div>
    </template>
    <div v-else-if="failure" class="p-3" data-testid="remotes-error">
      <ErrorBanner
        :message="failure.message"
        :output="failure.output"
        :action="t('remotes.tryAgain')"
        @action="() => void remotes.load()"
      />
    </div>
    <EmptyState
      v-else-if="remotes.remotes.length === 0"
      :message="t('remotes.empty')"
      data-testid="remotes-empty"
    />
    <div
      v-else
      ref="grid"
      role="grid"
      :aria-label="t('remotes.title')"
      class="flex flex-col py-2"
      data-testid="remotes-list"
      @keydown="onGridKeydown"
    >
      <div
        v-for="(remote, index) in remotes.remotes"
        :key="remote.name"
        role="row"
        :data-index="index"
        :tabindex="index === tabStop ? 0 : -1"
        class="sheet-row flex items-center gap-3 px-5 hover:bg-hover"
        :class="{ 'bg-selected': index === selected }"
        :aria-selected="index === selected ? 'true' : 'false'"
        :data-remote="remote.name"
        @focus="selected = index"
        @click="selected = index"
        @keydown="onRowActionsKeydown"
      >
        <span role="gridcell" class="flex min-w-0 flex-1 items-center gap-3">
          <Cloud
            :size="16"
            :stroke-width="1.5"
            aria-hidden="true"
            class="shrink-0 text-fg-secondary"
          />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="text-md text-fg" data-testid="remote-row-name">{{ remote.name }}</span>
            <span
              class="truncate font-mono text-mono-sm text-fg-secondary"
              data-testid="remote-row-url"
            >
              {{ remote.fetchUrl }}
            </span>
          </span>
        </span>
        <span role="gridcell" class="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            :disabled="busy"
            tabindex="-1"
            data-row-action
            data-testid="remote-fetch"
            @click="() => void remotes.fetch(remote.name, false)"
          >
            {{ t("remotes.fetch") }}
          </Button>
          <Button
            variant="ghost"
            :disabled="busy"
            tabindex="-1"
            data-row-action
            data-testid="remote-fetch-prune"
            @click="() => void remotes.fetch(remote.name, true)"
          >
            {{ t("remotes.fetchPrune") }}
          </Button>
          <IconButton
            :label="t('remotes.remove')"
            :icon="Trash2"
            :disabled="busy"
            tabindex="-1"
            data-row-action
            data-testid="remote-remove"
            @click="remotes.ask({ kind: 'removeRemote', name: remote.name })"
          />
        </span>
      </div>
    </div>
    <Dialog
      v-if="removing"
      :title="t('remotes.removeTitle', { name: removing })"
      :body="t('remotes.removeBody', { name: removing })"
      :confirm-label="t('remotes.removeConfirm')"
      variant="destructive"
      data-testid="remote-remove-dialog"
      @confirm="confirmRemove"
      @cancel="remotes.dismiss()"
    />
  </Sheet>
</template>

<style scoped>
/* The name field of the add form is 160px in the sheet; not on the spacing scale. */
.remote-name {
  width: 160px;
  flex: none;
}

/* A row is 48px (two lines of text); no row token is 48. */
.sheet-row {
  height: 48px;
}
</style>
