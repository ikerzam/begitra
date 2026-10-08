<script setup lang="ts">
// The Code filter of the graph's bar: its button (`FilterButton`), reading the search's text while
// active, with the choice in its tooltip and its name, and the popover it opens.

import { Code } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import { useGraphStore } from "@/stores/graph";

import CodePopover from "./CodePopover.vue";
import FilterButton from "./FilterButton.vue";

const { t } = useI18n();
const graph = useGraphStore();

const open = ref(false);
const button = ref<{ $el: HTMLElement } | null>(null);
const search = computed(() => graph.filters.code);
/** "Added or removed" or "On a changed line", for the tooltip and the name. */
const mode = computed(() => (search.value?.lines ? t("graph.codeLines") : t("graph.codeAdded")));

/**
 * Closing the popover unmounts its focused input: the focus returns to the button, once it reads
 * the new text (so the row scrolls it whole into view), unless the focus already went elsewhere.
 */
function close(refocus = true): void {
  open.value = false;
  if (refocus) void nextTick(() => button.value?.$el.focus());
}
</script>

<template>
  <div class="relative shrink-0">
    <FilterButton
      ref="button"
      :icon="Code"
      :label="t('graph.code')"
      :value="search?.text ?? null"
      :active-label="search ? t('graph.codeActive', { mode, text: search.text }) : undefined"
      :active-tooltip="search ? t('graph.codeTooltip', { mode, text: search.text }) : undefined"
      :expanded="open"
      data-testid="filter-code"
      @click="open = !open"
    />
    <CodePopover
      v-if="open"
      :code="search"
      :anchor="button?.$el"
      @apply="graph.setCode"
      @close="close"
    />
  </div>
</template>
