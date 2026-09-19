<script setup lang="ts">
import { ArrowDown, ArrowUp } from "@lucide/vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    ahead?: number;
    behind?: number;
  }>(),
  { ahead: 0, behind: 0 },
);

const { t, n } = useI18n();
</script>

<template>
  <span
    role="img"
    :aria-label="t('aheadBehind.label', { ahead: n(props.ahead), behind: n(props.behind) })"
    class="inline-flex shrink-0 items-center gap-2 text-sm whitespace-nowrap tabular-nums"
  >
    <span
      class="inline-flex items-center"
      :class="props.ahead > 0 ? 'text-ok' : 'text-fg-muted'"
      data-testid="ahead"
    >
      <ArrowUp :size="12" :stroke-width="1.5" aria-hidden="true" />{{ n(props.ahead) }}
    </span>
    <span
      class="inline-flex items-center"
      :class="props.behind > 0 ? 'text-warn' : 'text-fg-muted'"
      data-testid="behind"
    >
      <ArrowDown :size="12" :stroke-width="1.5" aria-hidden="true" />{{ n(props.behind) }}
    </span>
  </span>
</template>
