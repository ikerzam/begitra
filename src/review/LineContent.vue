<script setup lang="ts">
// The text of one diff line: intra-line emphasis on the changed bytes, the syntax colour of
// each token class, and the find's matches (`--find-match`, the current one `--find-current`
// with a `--warn` outline) in place of the emphasis where they meet. The diff's own facts stay
// in the row tint, the marker and the emphasis background, so the text colour is free for the
// syntax. Without wrap the text moves sideways by the viewer's `--diff-scroll-x` inside its
// clipping span.

import { computed } from "vue";

import type { DiffLine, Token, TokenClass } from "@/ipc/schemas";

import { segments, type LineMark, type Segment } from "./diffRows";

const props = withDefaults(
  defineProps<{
    line: DiffLine;
    tokens?: Token[];
    /** Wrap long lines instead of clipping them. */
    wrap?: boolean;
    /** The find's matches on the line. */
    marks?: LineMark[];
  }>(),
  { tokens: () => [], wrap: false, marks: () => [] },
);

/**
 * The segments in runs: the segments of one match share a run, whose span draws the match's
 * background and outline once around all its syntax colours; any other segment is a run alone.
 */
const runs = computed(() => {
  const list: { find: Segment["find"]; parts: Segment[] }[] = [];
  for (const segment of segments(props.line, props.tokens, props.marks)) {
    const last = list.at(-1);
    if (segment.find && last?.find === segment.find) last.parts.push(segment);
    else list.push({ find: segment.find, parts: [segment] });
  }
  return list;
});

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

/** A segment's own classes: its syntax colour, and its emphasis outside a match. */
function classOf(segment: Segment): string {
  const colour = syntax[segment.class];
  if (!segment.emphasis || segment.find) return colour;
  const emphasis = props.line.kind === "added" ? "bg-add-emphasis" : "bg-del-emphasis";
  return colour ? `${colour} ${emphasis}` : emphasis;
}

/** A match's run: its background, and the current one's outline. */
function findClass(find: Segment["find"]): string {
  return find === "current" ? "bg-find-current outline outline-1 outline-warn" : "bg-find-match";
}
</script>

<template>
  <span
    class="block select-text"
    :class="props.wrap ? 'break-all whitespace-pre-wrap' : 'overflow-hidden whitespace-pre'"
    data-testid="line-content"
    ><span class="block" :class="{ 'line-shift': !props.wrap }" data-testid="line-text"
      ><template v-for="(run, r) in runs" :key="r"
        ><span v-if="run.find" :class="findClass(run.find)"
          ><template v-for="(segment, i) in run.parts" :key="i"
            ><span v-if="classOf(segment)" :class="classOf(segment)">{{ segment.text }}</span
            ><template v-else>{{ segment.text }}</template></template
          ></span
        ><template v-else
          ><template v-for="(segment, i) in run.parts" :key="i"
            ><span v-if="classOf(segment)" :class="classOf(segment)">{{ segment.text }}</span
            ><template v-else>{{ segment.text }}</template></template
          ></template
        ></template
      ></span
    ></span
  >
</template>

<style scoped>
/* The viewer's sideways scroll: every line's text moves by the same offset, the gutters stay. */
.line-shift {
  transform: translateX(calc(var(--diff-scroll-x, 0px) * -1));
}
</style>
