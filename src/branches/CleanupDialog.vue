<script setup lang="ts">
// The cleanup dialog: the branches that can go against the main branch, each with its reason,
// its worktree and its date, ticked or not; "Fetch and prune" at the footer's start; the
// destructive confirm with the counts. Reading shows skeleton rows, nothing to clean up a
// sentence in the list's place, a failed listing the error banner with git's output and "Try
// again"; a live region says the first two. The list is one tab stop (`useChecklistNavigation`),
// a click anywhere on a row ticks it, and a branch whose worktree is locked cannot be ticked.

import { RefreshCw, TriangleAlert } from "@lucide/vue";
import { computed, nextTick, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Checkbox from "@/components/Checkbox.vue";
import Dialog from "@/components/Dialog.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { useChecklistNavigation } from "@/shortcuts/useChecklistNavigation";
import { useCleanupStore } from "@/stores/cleanup";

import { useCleanupTexts } from "./useCleanupTexts";

const { t } = useI18n();
const cleanup = useCleanupStore();
const texts = useCleanupTexts();

const content = useTemplateRef<HTMLElement>("content");
const list = useTemplateRef<HTMLElement>("list");
const navigation = useChecklistNavigation({
  keys: computed(() => cleanup.rows.filter((row) => !row.locked).map((row) => row.name)),
  list,
  attribute: "name",
});

/*
 * Once a listing answers, the focus goes to the list's tab stop (else "Fetch and prune") while it
 * is still where the dialog left it: on the footer's first control at the opening, or on the panel
 * once "Fetch and prune" turned disabled under it. Never away from a control the user moved to.
 */
let opening = true;
watch(
  () => cleanup.loading,
  (loading) => {
    if (loading) return;
    const first = opening;
    opening = false;
    void nextTick(() => {
      const panel = content.value?.closest<HTMLElement>('[role="dialog"]');
      if (!panel) return;
      const fetch = panel.querySelector<HTMLButtonElement>("[data-cleanup-fetch]");
      const active = document.activeElement;
      const adrift = active === null || active === document.body || active === panel;
      if (!adrift && !(first && active === fetch)) return;
      if (!navigation.focusStop() && fetch && !fetch.disabled) fetch.focus();
    });
  },
);
</script>

<template>
  <Dialog
    size="lg"
    variant="destructive"
    :title="t('cleanup.title')"
    :body="texts.body.value"
    :confirm-label="texts.confirmLabel.value"
    :confirm-disabled="cleanup.loading || cleanup.chosen.length === 0"
    data-testid="cleanup-dialog"
    @confirm="cleanup.confirm()"
    @cancel="cleanup.close()"
  >
    <div ref="content" class="contents">
      <p class="sr-only" role="status" data-testid="cleanup-status">{{ texts.status.value }}</p>
      <ErrorBanner
        v-if="cleanup.error"
        :message="texts.failure.value"
        :output="cleanup.error.detail ?? cleanup.error.message"
        :action="t('cleanup.tryAgain')"
        data-testid="cleanup-error"
        @action="cleanup.list()"
      />
      <div
        v-else-if="cleanup.loading"
        class="cleanup-box flex flex-col rounded-md border border-line"
        aria-hidden="true"
        data-testid="cleanup-loading"
      >
        <SkeletonRow v-for="index in 3" :key="index" :index="index - 1" />
      </div>
      <p
        v-else-if="cleanup.rows.length === 0"
        class="rounded-md border border-line px-4 py-5 text-center text-md text-fg-secondary"
        data-testid="cleanup-empty"
      >
        {{ texts.empty.value }}
      </p>
      <div
        v-else
        ref="list"
        class="cleanup-box cleanup-list flex flex-col overflow-y-auto rounded-md border border-line"
        role="group"
        :aria-label="t('cleanup.listLabel')"
        data-testid="cleanup-list"
        @focusin="navigation.onFocusin"
        @keydown="navigation.onKeydown"
      >
        <Checkbox
          v-for="row in cleanup.rows"
          :key="row.name"
          block
          class="cleanup-row px-3"
          :model-value="!row.locked && cleanup.ticked.has(row.name)"
          :disabled="row.locked"
          :focusable="row.name === navigation.stop.value"
          :data-name="row.name"
          data-testid="cleanup-row"
          @update:model-value="cleanup.toggle(row.name)"
        >
          <span class="cleanup-text flex min-w-0 flex-1 flex-col">
            <span
              class="truncate font-medium"
              :class="row.locked ? 'text-fg-disabled' : 'text-fg'"
              :data-tooltip="row.name"
              data-testid="cleanup-name"
            >
              {{ row.name }}
            </span>
            <span
              class="flex min-w-0 items-center gap-1 text-sm"
              :class="row.locked ? 'text-fg-disabled' : 'text-fg-secondary'"
            >
              <TriangleAlert
                v-if="row.warn && !row.locked"
                class="shrink-0 text-warn"
                :size="12"
                :stroke-width="1.5"
                aria-hidden="true"
                data-testid="cleanup-warn"
              />
              <span class="truncate" :data-tooltip="texts.reason(row)" data-testid="cleanup-reason">
                {{ texts.reason(row) }}
              </span>
            </span>
          </span>
          <span
            class="ml-2 shrink-0 text-sm"
            :class="row.locked ? 'text-fg-disabled' : 'text-fg-muted'"
            data-testid="cleanup-date"
          >
            {{ texts.date(row) }}
          </span>
        </Checkbox>
      </div>
    </div>
    <template #footer-start>
      <Button
        variant="ghost"
        size="lg"
        :icon="RefreshCw"
        :disabled="cleanup.fetching"
        data-cleanup-fetch
        data-testid="cleanup-fetch"
        @click="cleanup.fetchAndPrune()"
      >
        {{ t("cleanup.fetchAndPrune") }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
/* The list's box keeps 4px above its first row and below its last; about seven rows show
   before it scrolls. */
.cleanup-box {
  padding-block: var(--space-1);
}
.cleanup-list {
  max-height: 360px;
}
/* A row is 6px above and below its two lines, off the scale. */
.cleanup-row {
  padding-block: 6px;
}
/* The name and the reason sit 2px apart, off the scale. */
.cleanup-text {
  gap: 2px;
}
</style>
