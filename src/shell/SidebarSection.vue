<script setup lang="ts">
// A section of the sidebar's column: a header a list row tall that stays at the column's top while
// the section's rows scroll under it, one button (in a heading, so a screen reader can jump between
// sections) with the chevron, the name and the count, the section's actions beside it, and the
// rows while the section is open. The chevron sits in an icon box past a row's border, so it lines
// up with the rows' icons and the name with theirs. A section whose rows failed to load shows the
// alert icon in place of its count, folded or open.

import { ChevronDown, ChevronRight, CircleAlert } from "@lucide/vue";
import { useId } from "vue";

const props = withDefaults(
  defineProps<{
    heading: string;
    /** "12", or "2 of 12" while a filter narrows the rows; none while they are read. */
    count: string;
    folded: boolean;
    /** What failed, as the alert icon's label; none when nothing did. */
    alert?: string;
  }>(),
  { alert: "" },
);
const emit = defineEmits<{ toggle: [] }>();

const bodyId = useId();
</script>

<template>
  <section class="flex flex-col" data-testid="sidebar-section">
    <div
      class="sidebar-section-header sticky top-0 flex h-row-list shrink-0 items-center gap-1 bg-app pr-2"
    >
      <h2 class="flex h-full min-w-0 flex-1">
        <button
          type="button"
          class="sidebar-section-toggle flex h-full min-w-0 flex-1 items-center gap-2 border-l-2 border-transparent pl-3 hover:bg-hover"
          :aria-expanded="!props.folded"
          :aria-controls="props.folded ? undefined : bodyId"
          data-testid="section-header"
          @click="emit('toggle')"
        >
          <span class="flex size-icon shrink-0 items-center justify-center text-fg-secondary">
            <component
              :is="props.folded ? ChevronRight : ChevronDown"
              :size="12"
              :stroke-width="1.5"
              aria-hidden="true"
            />
          </span>
          <span class="truncate text-md font-medium text-fg-secondary" data-testid="section-title">
            {{ props.heading }}
          </span>
          <span
            v-if="props.alert"
            role="img"
            :aria-label="props.alert"
            :data-tooltip="props.alert"
            class="flex shrink-0 text-danger"
            data-testid="section-alert"
          >
            <CircleAlert :size="12" :stroke-width="1.5" aria-hidden="true" />
          </span>
          <span
            v-else-if="props.count"
            class="shrink-0 text-sm text-fg-muted"
            data-testid="section-count"
          >
            {{ props.count }}
          </span>
        </button>
      </h2>
      <slot name="actions" />
    </div>
    <div v-if="!props.folded" :id="bodyId">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* Above the rows that scroll under it; not on the z scale, which starts at the overlays. */
.sidebar-section-header {
  z-index: 1;
}

/* The ring goes inside: the column's scroll box clips whatever falls outside the button. */
.sidebar-section-toggle:focus-visible {
  outline-offset: -2px;
}
</style>
