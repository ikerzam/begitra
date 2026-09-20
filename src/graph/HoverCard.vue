<script setup lang="ts">
// The graph's hover card: a 360px overlay next to the row after the pointer
// rests on it, with the subject, the author with email, the absolute and relative date, the
// full hash with a copy button, the parent links, the badges, then "Diff from here" and
// "Compare with…". The panel decides when it shows; the card only positions itself.

import { Copy, FileDiff, GitCompareArrows } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import RefBadge from "@/components/RefBadge.vue";
import type { CommitNode, Ref as GitRef } from "@/ipc/schemas";
import { absoluteDate, relativeDate, shortHash } from "@/shell/format";
import { useNow } from "@/shell/useNow";

import { commitBadges, refsByName } from "./badges";

const props = defineProps<{
  commit: CommitNode;
  refs: GitRef[];
  /** The row the card belongs to, in viewport coordinates. */
  anchor: DOMRect;
}>();
const emit = defineEmits<{
  copyHash: [];
  selectParent: [hash: string];
  diffFrom: [];
  enter: [];
  leave: [];
}>();
/** Width of the card. */
const CARD_WIDTH = 360;
/** Gap between the row and the card, and between the card and the viewport edges. */
const GAP = 8;
/** Horizontal offset from the row's left edge to the card. */
const LEFT_OFFSET = 320;

const { t, locale } = useI18n();
const now = useNow();
const card = ref<HTMLElement | null>(null);
const top = ref(props.anchor.bottom + GAP);
const flipped = ref(false);

const relative = computed(() => {
  const rel = relativeDate(props.commit.author.time, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
});
const absolute = computed(() => absoluteDate(props.commit.author.time, locale.value));
const badges = computed(() => commitBadges(props.commit.refs, refsByName(props.refs)));

const left = computed(() => {
  const width = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
  return Math.max(GAP, Math.min(props.anchor.left + LEFT_OFFSET, width - CARD_WIDTH - GAP));
});

// Below the row by default; above it when the card would leave the viewport.
onMounted(() => {
  const height = card.value?.offsetHeight ?? 0;
  const viewport = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerHeight;
  if (props.anchor.bottom + GAP + height > viewport && props.anchor.top - GAP - height >= 0) {
    flipped.value = true;
    top.value = props.anchor.top - GAP - height;
  }
});
</script>

<template>
  <div
    ref="card"
    role="dialog"
    :aria-label="props.commit.subject"
    class="hover-card fixed z-20 flex flex-col rounded-lg border border-line-strong bg-raised shadow-overlay"
    :class="{ 'hover-card-flipped': flipped }"
    :style="{ left: `${left}px`, top: `${top}px` }"
    data-testid="hover-card"
    @pointerenter="emit('enter')"
    @pointerleave="emit('leave')"
  >
    <div class="flex flex-col gap-2 px-3 pt-3 pb-2">
      <p class="text-md font-medium text-fg" data-testid="hover-subject">
        {{ props.commit.subject }}
      </p>
      <p class="flex items-center gap-2 text-sm">
        <span class="text-fg">{{ props.commit.author.name }}</span>
        <span class="text-fg-muted">{{ props.commit.author.email }}</span>
      </p>
      <p class="flex items-center gap-2 text-sm text-fg-secondary">
        <span>{{ absolute }}</span>
        <span class="text-fg-muted">({{ relative }})</span>
      </p>
      <p class="flex items-center justify-between gap-2">
        <span class="truncate font-mono text-mono-sm text-fg-secondary" data-testid="hover-hash">
          {{ props.commit.hash }}
        </span>
        <IconButton :icon="Copy" :label="t('detail.copyHash')" @click="emit('copyHash')" />
      </p>
      <p
        v-if="props.commit.parents.length > 0"
        class="flex items-center gap-2 text-sm text-fg-secondary"
      >
        <span>
          {{ props.commit.parents.length > 1 ? t("detail.parents") : t("detail.parent") }}
        </span>
        <button
          v-for="parent in props.commit.parents"
          :key="parent"
          type="button"
          class="font-mono text-mono-sm text-link hover:underline"
          @click="emit('selectParent', parent)"
        >
          {{ shortHash(parent) }}
        </button>
      </p>
      <div v-if="badges.length > 0" class="flex flex-wrap items-center gap-2">
        <RefBadge
          v-for="badge in badges"
          :key="badge.key"
          :kind="badge.kind"
          :label="badge.label"
        />
      </div>
    </div>
    <div class="flex items-center gap-2 border-t border-line px-2 py-1">
      <Button
        variant="ghost"
        :icon="FileDiff"
        data-testid="hover-diff-from"
        @click="emit('diffFrom')"
      >
        {{ t("graph.diffFromHere") }}
      </Button>
      <Button
        variant="ghost"
        :icon="GitCompareArrows"
        disabled
        :title="t('graph.compareLater')"
        data-testid="hover-compare"
      >
        {{ t("graph.compareWith") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* The card is 360px wide; not on the spacing scale. */
.hover-card {
  width: 360px;
}
</style>
