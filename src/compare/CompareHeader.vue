<script setup lang="ts">
// The comparison's header: "Compare", the two endpoint controls (the Select
// treatment with the endpoint's lane dot; each opens the picker for that side), the swap
// control and "Open in terminal".

import { ArrowLeftRight, ChevronDown, Terminal } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import { laneBgClass } from "@/components/lanes";
import type { CompareSide } from "@/stores/compare";
import type { CompareEndpoint } from "@/stores/settings";

const props = defineProps<{
  a: CompareEndpoint;
  b: CompareEndpoint;
  /** Lane of each endpoint's branch, 0 when it has none. */
  lanes: Record<CompareSide, number>;
}>();
const emit = defineEmits<{ pick: [side: CompareSide]; swap: []; openTerminal: [] }>();

const { t } = useI18n();
</script>

<template>
  <header
    class="flex h-panel-header shrink-0 items-center gap-3 border-b border-line px-3"
    data-testid="compare-header"
  >
    <h2 class="text-base font-semibold text-fg">{{ t("compare.title") }}</h2>
    <button
      v-for="side in ['a', 'b'] as const"
      :key="side"
      type="button"
      class="compare-endpoint flex h-control items-center gap-2 rounded-sm border border-line-strong bg-app pr-2 pl-3 text-md text-fg hover:bg-hover"
      :class="{ 'order-3': side === 'b' }"
      :aria-label="t('compare.pickEndpoint', { side: side.toUpperCase() })"
      :data-testid="`compare-endpoint-${side}`"
      @click="emit('pick', side)"
    >
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="props.lanes[side] > 0 ? laneBgClass(props.lanes[side]) : 'bg-fg-muted'"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1 truncate text-left">{{ props[side].label }}</span>
      <ChevronDown :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
    </button>
    <IconButton
      class="order-2"
      :label="t('compare.swap')"
      :icon="ArrowLeftRight"
      data-testid="compare-swap"
      @click="emit('swap')"
    />
    <span class="order-4 flex-1" />
    <Button
      class="order-5"
      variant="ghost"
      :icon="Terminal"
      data-testid="compare-terminal"
      @click="emit('openTerminal')"
    >
      {{ t("palette.commandsById.open-terminal") }}
    </Button>
  </header>
</template>

<style scoped>
/* The endpoint controls are 300px wide; off the spacing scale. */
.compare-endpoint {
  width: 300px;
}
</style>
