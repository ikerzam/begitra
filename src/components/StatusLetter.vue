<script setup lang="ts">
import { useI18n } from "vue-i18n";

import type { FileStatus } from "./types";

const props = defineProps<{ status: FileStatus }>();

const { t } = useI18n();

const colorClasses: Record<FileStatus, string> = {
  added: "text-add",
  modified: "text-warn",
  deleted: "text-del",
  renamed: "text-warn",
};
</script>

<template>
  <span
    role="img"
    :aria-label="t(`statusLetter.title.${props.status}`)"
    :title="t(`statusLetter.title.${props.status}`)"
    :data-status="props.status"
    class="status-letter inline-flex w-3 shrink-0 justify-center font-ui font-semibold"
    :class="colorClasses[props.status]"
  >
    {{ t(`statusLetter.${props.status}`) }}
  </span>
</template>

<style scoped>
/* 11/600: the one glyph outside the type scale. */
.status-letter {
  font-size: 11px;
  line-height: 1;
}
</style>
