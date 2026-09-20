<script setup lang="ts">
// The text of one diff line: intra-line emphasis on the changed bytes and the two-tone token
// treatment of the highlighter (comments muted, strings secondary; the other classes inherit
// the text colour, since the interface keeps colour for facts).

import { computed } from "vue";

import type { DiffLine, Token } from "@/ipc/schemas";

import { segments, type Segment } from "./diffRows";

const props = withDefaults(
  defineProps<{
    line: DiffLine;
    tokens?: Token[];
    /** Wrap long lines instead of clipping them. */
    wrap?: boolean;
  }>(),
  { tokens: () => [], wrap: false },
);

const parts = computed(() => segments(props.line, props.tokens));

function classOf(segment: Segment): string {
  const tone =
    segment.class === "comment"
      ? "text-fg-muted"
      : segment.class === "string"
        ? "text-fg-secondary"
        : "";
  if (!segment.emphasis) return tone;
  return `${tone} ${props.line.kind === "added" ? "bg-add-emphasis" : "bg-del-emphasis"}`;
}
</script>

<template>
  <span
    class="block"
    :class="props.wrap ? 'break-all whitespace-pre-wrap' : 'overflow-hidden whitespace-pre'"
    data-testid="line-content"
    ><template v-for="(segment, i) in parts" :key="i"
      ><span v-if="classOf(segment)" :class="classOf(segment)">{{ segment.text }}</span
      ><template v-else>{{ segment.text }}</template></template
    ></span
  >
</template>
