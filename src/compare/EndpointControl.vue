<script setup lang="ts">
// One endpoint of the comparison in the header: the Select treatment (border, lane dot,
// name, chevron) as a button that opens the picker for its side. The accessible name
// carries the side and the value, so a reader hears "Side A: main".

import { ChevronDown } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { laneBgClass } from "@/components/lanes";
import type { CompareSide } from "@/stores/compare";
import type { CompareEndpoint } from "@/stores/settings";

const props = defineProps<{
  side: CompareSide;
  endpoint: CompareEndpoint;
  /** Lane of the endpoint's branch, 0 when it has none. */
  lane: number;
}>();
const emit = defineEmits<{ pick: [] }>();

const { t } = useI18n();
</script>

<template>
  <button
    type="button"
    class="compare-endpoint flex h-control items-center gap-2 rounded-sm border border-line-strong bg-app pr-2 pl-3 text-md text-fg hover:bg-hover"
    :aria-label="
      t('compare.endpoint', { side: props.side.toUpperCase(), label: props.endpoint.label })
    "
    :data-testid="`compare-endpoint-${props.side}`"
    @click="emit('pick')"
  >
    <span
      class="h-2 w-2 shrink-0 rounded-full"
      :class="props.lane > 0 ? laneBgClass(props.lane) : 'bg-fg-muted'"
      aria-hidden="true"
    />
    <span class="min-w-0 flex-1 truncate text-left">{{ props.endpoint.label }}</span>
    <ChevronDown :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
  </button>
</template>

<style scoped>
/* 300px wide: room for long branch names; off the spacing scale. */
.compare-endpoint {
  width: 300px;
}
</style>
