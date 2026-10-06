<script setup lang="ts">
// The text of one diff line: intra-line emphasis on the changed bytes, the syntax colour of
// each token class, and the find's matches (`--find-match`, the current one `--find-current`
// with a `--warn` outline, their text in `--text`) in place of both where they meet. The diff's own facts stay
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

/** A segment's own classes outside a match: its syntax colour and its emphasis. */
function classOf(segment: Segment): string {
  const colour = syntax[segment.class];
  if (!segment.emphasis) return colour;
  const emphasis = props.line.kind === "added" ? "bg-add-emphasis" : "bg-del-emphasis";
  return colour ? `${colour} ${emphasis}` : emphasis;
}

/**
 * A match's run: its background with the text in `--text` (the syntax colours are not kept 3:1
 * on a highlight, the text is 4.5:1), and the current one's outline, drawn inside the run so the
 * line's clipping never cuts it at the first column.
 */
function findClass(find: Segment["find"]): string {
  return find === "current"
    ? "bg-find-current text-fg outline outline-1 -outline-offset-1 outline-warn"
    : "bg-find-match text-fg";
}

/** A run's whole text: a match draws as one span. */
function textOf(parts: Segment[]): string {
  return parts.map((part) => part.text).join("");
}
</script>

<template>
  <span
    class="block select-text"
    :class="props.wrap ? 'break-all whitespace-pre-wrap' : 'overflow-hidden whitespace-pre'"
    data-testid="line-content"
    ><span class="block" :class="{ 'line-shift': !props.wrap }" data-testid="line-text"
      ><template v-for="(run, r) in runs" :key="r"
        ><span v-if="run.find" :class="findClass(run.find)">{{ textOf(run.parts) }}</span
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
