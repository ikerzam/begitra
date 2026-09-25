<script setup lang="ts">
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <span
    role="img"
    :aria-label="t('dirtyDot.label')"
    :data-tooltip="t('dirtyDot.label')"
    class="dirty-dot inline-block shrink-0 rounded-full bg-warn"
  />
</template>

<style scoped>
/* The dot is 6px; the spacing scale has no 6. */
.dirty-dot {
  width: 6px;
  height: 6px;
}
</style>
