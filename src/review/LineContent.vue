<script setup lang="ts">
// The text of one diff line: intra-line emphasis on the changed bytes and the syntax colour of
// each token class. The diff's own facts stay in the row tint, the
// marker and the emphasis background, so the text colour is free for the syntax.

import { computed } from "vue";

import type { DiffLine, Token, TokenClass } from "@/ipc/schemas";

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

/** The colour of each class; plain text keeps the line's own. */
const syntax: Record<TokenClass, string> = {
  plain: "",
  keyword: "text-syntax-keyword",
  function: "text-syntax-function",
  type: "text-syntax-type",
  string: "text-syntax-string",
  number: "text-syntax-number",
  comment: "text-syntax-comment",
  punctuation: "text-fg-secondary",
};

function classOf(segment: Segment): string {
  const colour = syntax[segment.class];
  if (!segment.emphasis) return colour;
  const emphasis = props.line.kind === "added" ? "bg-add-emphasis" : "bg-del-emphasis";
  return colour ? `${colour} ${emphasis}` : emphasis;
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
