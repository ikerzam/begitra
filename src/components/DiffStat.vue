<script setup lang="ts">
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    added?: number;
    removed?: number;
  }>(),
  { added: 0, removed: 0 },
);

const { t, n } = useI18n();
</script>

<template>
  <span
    role="img"
    :aria-label="t('diffStat.label', { added: n(props.added), removed: n(props.removed) })"
    class="inline-flex shrink-0 items-center gap-2 text-md whitespace-nowrap tabular-nums"
  >
    <span :class="props.added > 0 ? 'text-add' : 'text-fg-muted'" data-testid="diff-stat-added">
      {{ t("diffStat.added", { n: n(props.added) }) }}
    </span>
    <span :class="props.removed > 0 ? 'text-del' : 'text-fg-muted'" data-testid="diff-stat-removed">
      {{ t("diffStat.removed", { n: n(props.removed) }) }}
    </span>
  </span>
</template>
