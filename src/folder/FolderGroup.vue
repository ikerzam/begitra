<script setup lang="ts">
// The group of the folder view's repositories without changes and of those being read: one
// closed disclosure naming how many of each, 16px apart, which opens to their rows, each with
// "No changes" or "Reading…".

import { ChevronDown, ChevronRight } from "@lucide/vue";
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";

import { useFolderStore } from "@/stores/folder";

const { t, n } = useI18n();
const folder = useFolderStore();
const listId = useId();

/** Clean and unread repositories together, in path order. */
const grouped = computed(() =>
  [...folder.clean, ...folder.checking].sort((a, b) => a.root.localeCompare(b.root)),
);
</script>

<template>
  <div v-if="grouped.length > 0" class="flex flex-col" data-testid="folder-group">
    <button
      type="button"
      class="flex h-panel-header shrink-0 items-center gap-2 px-3 text-left text-sm text-fg-muted hover:bg-hover"
      :aria-expanded="folder.groupOpen"
      :aria-controls="listId"
      data-testid="folder-group-toggle"
      @click="folder.toggleGroup()"
    >
      <span class="flex size-icon shrink-0 items-center justify-center">
        <component
          :is="folder.groupOpen ? ChevronDown : ChevronRight"
          :size="12"
          :stroke-width="1.5"
          aria-hidden="true"
        />
      </span>
      <span class="flex min-w-0 items-center gap-4">
        <span v-if="folder.clean.length > 0" class="truncate">
          {{ t("folder.clean", { n: n(folder.clean.length) }, folder.clean.length) }}
        </span>
        <span v-if="folder.checking.length > 0" class="truncate">
          {{ t("folder.reading", { n: n(folder.checking.length) }, folder.checking.length) }}
        </span>
      </span>
    </button>
    <ul
      v-show="folder.groupOpen"
      :id="listId"
      class="flex flex-col pb-1"
      data-testid="folder-group-list"
    >
      <li
        v-for="repository in grouped"
        :key="repository.root"
        class="flex h-row-list items-center gap-2 pr-3 pl-6 text-md"
        data-testid="folder-group-row"
      >
        <span class="min-w-0 truncate text-fg-secondary" :data-tooltip="repository.root">
          {{ repository.name }}
        </span>
        <span class="ml-auto shrink-0 text-sm text-fg-muted">
          {{ repository.view.counts === null ? t("folder.readingOne") : t("folder.noChanges") }}
        </span>
      </li>
    </ul>
  </div>
</template>
