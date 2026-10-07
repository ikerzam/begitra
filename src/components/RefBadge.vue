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
    /** The remote of the branch's upstream on the same commit, drawn after a divider. */
    remote?: string;
  }>(),
  { label: "", worktreeLane: 0, remote: "" },
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

/** The badge's kind, and its upstream when one is joined to it. */
const description = computed(() => {
  const kind = t(`refBadge.kind.${props.kind}`);
  return props.remote ? t("refBadge.withUpstream", { kind, remote: props.remote }) : kind;
});
</script>

<template>
  <span
    class="ref-badge inline-flex shrink-0 items-center gap-1 rounded-md border px-2 text-sm font-medium whitespace-nowrap"
    :class="kindClasses[props.kind]"
    :data-kind="props.kind"
    :data-tooltip="description"
    :aria-description="description"
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
    <span class="ref-badge-label truncate">{{ text }}</span>
    <template v-if="props.remote">
      <span
        class="ref-badge-divider shrink-0"
        :class="props.kind === 'current' ? 'bg-white' : 'bg-ref-local'"
        aria-hidden="true"
      />
      <span
        class="ref-badge-remote truncate font-normal"
        :class="props.kind === 'current' ? 'text-white' : 'text-fg-muted'"
        data-testid="ref-badge-remote"
      >
        {{ props.remote }}
      </span>
    </template>
  </span>
</template>

<style scoped>
/* An 18px pill whose label clips at 150px; a joined upstream's remote at 80. */
.ref-badge {
  height: 18px;
}

.ref-badge-label {
  max-width: 150px;
}

.ref-badge-remote {
  max-width: 80px;
}

/* `C/Badge/Ref/Upstream`'s 1px by 10px divider between the branch and its remote. */
.ref-badge-divider {
  width: 1px;
  height: 10px;
}
</style>
