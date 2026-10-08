<script setup lang="ts">
// The popover of the scope's "Branches matching…": a glob over the branches' names (`claude/*`),
// how many branches it matches as it is typed, and Apply; Enter applies, Escape, a press or a
// scroll outside and the focus leaving close, an empty pattern returns to every branch. Hangs
// under the scope's select (`useAnchoredPopover`), as the path's popover hangs from its button.

import { computed, ref, useId, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import { useAnchoredPopover } from "@/components/useAnchoredPopover";
import { MAX_SCOPE_NAMES } from "@/ipc/schemas";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";

import { patternNames } from "./scopeRefs";

const props = defineProps<{
  /** The pattern the scope holds, shown as the initial value. */
  pattern: string;
  /** The control that opened the popover; presses on it do not count as outside. */
  anchor?: HTMLElement | null;
}>();
/** `close`'s `refocus` is false when the focus already went elsewhere. */
const emit = defineEmits<{ apply: [pattern: string]; close: [refocus: boolean] }>();

const { t, n } = useI18n();
const repo = useRepoStore();
const remotes = useRemotesStore();
const root = useTemplateRef<HTMLElement>("root");
const titleId = useId();
const hintId = useId();
const value = ref(props.pattern);
// The field takes the focus after the select's list has closed and given its button the focus
// back.
const { box, onFocusOut } = useAnchoredPopover(
  root,
  () => props.anchor,
  (refocus) => emit("close", refocus),
  (popover) => popover.querySelector("input")?.focus(),
);

/**
 * "4 branches: 3 local, 1 remote", that none matches, or that the graph walks the first 2,000
 * of more; nothing while the field is empty.
 */
const matched = computed(() => {
  if (value.value.trim() === "") return "";
  const names = patternNames(value.value, repo.refs, remotes.remotes);
  if (names.length === 0) return t("graph.patternNone");
  const local = names.filter((name) => name.startsWith("refs/heads/")).length;
  const remote = names.length - local;
  const line = t(
    "graph.patternMatched",
    {
      n: n(names.length),
      local: t("graph.patternLocal", { n: n(local) }, local),
      remote: t("graph.patternRemote", { n: n(remote) }, remote),
    },
    names.length,
  );
  return names.length > MAX_SCOPE_NAMES
    ? t("graph.patternFirst", { line, n: n(MAX_SCOPE_NAMES) })
    : line;
});

function apply(): void {
  emit("apply", value.value.trim());
  emit("close", true);
}

function onKeydown(event: KeyboardEvent): void {
  // A key that ends an input method's composition is the composition's own.
  if (event.isComposing) return;
  // Enter on Cancel or Apply is the button's own.
  if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault();
    apply();
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close", true);
  }
}
</script>

<template>
  <div
    ref="root"
    role="dialog"
    :aria-label="t('graph.patternTitle')"
    :style="
      box
        ? { left: `${box.left}px`, top: `${box.top}px` }
        : { left: '0', top: '0', visibility: 'hidden' }
    "
    class="pattern-popover fixed z-20 flex flex-col gap-2 rounded-lg border border-line-strong bg-raised p-3 shadow-overlay"
    data-testid="pattern-popover"
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <span :id="titleId" class="text-sm text-fg-secondary">{{ t("graph.patternTitle") }}</span>
    <Input
      v-model="value"
      :placeholder="t('graph.patternPlaceholder')"
      spellcheck="false"
      :aria-labelledby="titleId"
      :aria-describedby="hintId"
      data-testid="pattern-input"
    />
    <span :id="hintId" class="text-sm text-fg-muted">{{ t("graph.patternHint") }}</span>
    <!-- Always in the accessibility tree, so a count that appears is announced. -->
    <span
      class="text-sm text-fg-secondary"
      :class="{ 'sr-only': !matched }"
      aria-live="polite"
      data-testid="pattern-matched"
    >
      {{ matched }}
    </span>
    <div class="flex justify-end gap-2">
      <Button variant="ghost" @click="emit('close', true)">{{ t("dialog.cancel") }}</Button>
      <Button variant="primary" data-testid="pattern-apply" @click="apply">
        {{ t("graph.apply") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* 280px wide, room for a pattern and its count; not on the spacing scale. */
.pattern-popover {
  width: 280px;
}
</style>
