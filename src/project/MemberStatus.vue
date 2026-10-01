<script setup lang="ts">
// The status cell of a project member: the operation in progress, a missing
// folder, a summary that could not be read, or a bulk operation's state, with its icon, the
// 48px progress bar while it runs and the toggle of git's output.

import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleMinus } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import Progress from "@/components/Progress.vue";

import type { RowStatus } from "./status";

const props = defineProps<{
  status: RowStatus;
  /** Whether the output of the status shows under the row. */
  outputOpen: boolean;
}>();
const emit = defineEmits<{ output: [] }>();

const { t } = useI18n();

/** The output toggle's name and tooltip, which its chevron shows without words. */
const outputLabel = computed(() =>
  props.outputOpen ? t("project.hideOutputLabel") : t("project.showOutputLabel"),
);

const icons = { check: CircleCheck, minus: CircleMinus, alert: CircleAlert } as const;
const tones = {
  fg: "text-fg",
  muted: "text-fg-muted",
  warn: "text-warn",
  danger: "text-danger",
} as const;
const iconTones = {
  fg: "text-ok",
  muted: "text-fg-muted",
  warn: "text-warn",
  danger: "text-danger",
} as const;
</script>

<template>
  <component
    :is="icons[props.status.icon]"
    v-if="props.status.icon"
    :size="16"
    :stroke-width="1.5"
    aria-hidden="true"
    class="shrink-0"
    :class="iconTones[props.status.tone]"
  />
  <span class="truncate" :class="tones[props.status.tone]">{{ props.status.text }}</span>
  <Progress
    v-if="props.status.progress !== undefined"
    class="status-progress shrink-0"
    :value="props.status.progress ?? 0"
    :indeterminate="props.status.progress === null"
  />
  <IconButton
    v-if="props.status.output"
    :label="outputLabel"
    :icon="props.outputOpen ? ChevronDown : ChevronRight"
    tabindex="-1"
    data-row-action
    :aria-expanded="props.outputOpen"
    data-testid="member-output-toggle"
    @click.stop="emit('output')"
  />
</template>

<style scoped>
/* The 48px bar of a running member; no width step is 48. */
.status-progress {
  width: 48px;
}
</style>
