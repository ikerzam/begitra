<script setup lang="ts">
// The find bar of review focus, under the diff's header while the find is open: the query
// (↵ the next match, ⇧↵ the previous one, Escape closes), "Match case", the count ("3 of 41",
// "No results", "10,000+" past the limit), previous, next and close. Closing hands the focus to
// the diff (`close`), whose cursor sits on the current match.

import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import { useFindStore } from "@/stores/find";

const emit = defineEmits<{ close: [] }>();

const { t, n } = useI18n();
const find = useFindStore();
const field = ref<{ $el: HTMLElement } | null>(null);
const nextKeys = useShortcutHint("find-next");
const previousKeys = useShortcutHint("find-previous");

const query = computed({
  get: () => find.query,
  set: (text: string) => find.setQuery(text),
});

/**
 * "3 of 41"; "41 matches" before next or previous gives one a place; "No results" once a count
 * is final, and nothing while it waits, runs or the files are still read.
 */
const countText = computed(() => {
  if (find.count === 0) return find.query !== "" && !find.pending ? t("find.noResults") : "";
  const count = find.capped ? `${n(find.count)}+` : n(find.count);
  if (find.current < 0) return t("find.matches", { count }, find.count);
  return t("find.count", { current: n(find.current + 1), count });
});

/** The field takes the focus, its text selected, whenever ⌘F asks for it. */
watch(
  () => find.focusRequest,
  () =>
    void nextTick(() => {
      const input = field.value?.$el.querySelector("input");
      input?.focus();
      input?.select();
    }),
  { immediate: true },
);

function onFieldKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (event.shiftKey) find.previous();
  else find.next();
}

function close(): void {
  find.close();
  emit("close");
}
</script>

<template>
  <div
    v-if="find.open"
    role="search"
    :aria-label="t('find.label')"
    class="flex h-panel-header shrink-0 items-center gap-3 border-b border-line px-3"
    data-testid="find-bar"
    @keydown.escape.prevent.stop="close"
  >
    <div class="find-query">
      <Input
        ref="field"
        v-model="query"
        :icon="Search"
        :placeholder="t('find.placeholder')"
        :aria-label="t('find.label')"
        data-testid="find-query"
        @keydown="onFieldKeydown"
      />
    </div>
    <IconButton
      :label="t('find.matchCase')"
      :icon="CaseSensitive"
      :pressed="find.matchCase"
      data-testid="find-match-case"
      @click="find.setMatchCase(!find.matchCase)"
    />
    <span
      class="text-sm whitespace-nowrap text-fg-muted"
      aria-live="polite"
      data-testid="find-count"
      >{{ countText }}</span
    >
    <span class="flex-1" />
    <IconButton
      :label="t('find.previous')"
      :icon="ChevronUp"
      :keys="previousKeys"
      :disabled="find.count === 0"
      data-testid="find-previous"
      @click="find.previous()"
    />
    <IconButton
      :label="t('find.next')"
      :icon="ChevronDown"
      :keys="nextKeys"
      :disabled="find.count === 0"
      data-testid="find-next"
      @click="find.next()"
    />
    <IconButton
      :label="t('find.close')"
      :icon="X"
      keys="esc"
      data-testid="find-close"
      @click="close"
    />
  </div>
</template>

<style scoped>
/* The query's field: as wide as the graph's search and more, giving way first on a narrow diff. */
.find-query {
  width: 280px;
  min-width: 140px;
  flex-shrink: 1;
}
</style>
