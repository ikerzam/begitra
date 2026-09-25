<script setup lang="ts">
import { TreePine } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { laneTextClass } from "./lanes";
import type { RefKind } from "./types";

const props = withDefaults(
  defineProps<{
    kind: RefKind;
    /** Ref name. The `head` kind falls back to the translated "HEAD" label. */
    label?: string;
    /** Lane of the branch when it is checked out in a worktree; 0 hides the marker. */
    worktreeLane?: number;
  }>(),
  { label: "", worktreeLane: 0 },
);

const { t } = useI18n();

/* Outline badges keep `--text`; the current branch is the only filled one. */
const kindClasses: Record<RefKind, string> = {
  local: "border-ref-local text-fg",
  current: "border-ref-current bg-ref-current text-white",
  remote: "border-ref-remote text-fg",
  tag: "border-ref-tag text-fg",
  head: "border-ref-head text-fg",
  stash: "border-ref-stash text-fg",
};

const text = computed(() => props.label || (props.kind === "head" ? t("refBadge.head") : ""));
</script>

<template>
  <span
    class="ref-badge inline-flex shrink-0 items-center gap-1 rounded-md border px-2 text-sm font-medium whitespace-nowrap"
    :class="kindClasses[props.kind]"
    :data-kind="props.kind"
    :data-tooltip="t(`refBadge.kind.${props.kind}`)"
    :aria-description="t(`refBadge.kind.${props.kind}`)"
  >
    <TreePine
      v-if="props.worktreeLane > 0"
      :size="12"
      :stroke-width="1.5"
      role="img"
      :aria-label="t('refBadge.worktree')"
      class="shrink-0"
      :class="props.kind === 'current' ? 'text-white' : laneTextClass(props.worktreeLane)"
    />
    <span class="truncate">{{ text }}</span>
  </span>
</template>

<style scoped>
/* An 18px pill whose label clips at 150px. */
.ref-badge {
  height: 18px;
  max-width: 150px;
}
</style>
