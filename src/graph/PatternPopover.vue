<script setup lang="ts">
// The popover of the scope's "Branches matching…": a glob over the branches' names (`claude/*`),
// how many branches it matches as it is typed, and Apply; Enter applies, Escape and a press
// outside close, an empty pattern returns to every branch. Fixed under the scope's select, as the
// path's popover hangs from its button.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import { hangFrom, viewportSize } from "@/components/placement";
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
const emit = defineEmits<{ apply: [pattern: string]; close: [] }>();

const { t, n } = useI18n();
const repo = useRepoStore();
const remotes = useRemotesStore();
const root = useTemplateRef<HTMLElement>("root");
const titleId = useId();
const hintId = useId();
const value = ref(props.pattern);
/* Where it hangs from the select; null until it is measured. */
const box = ref<{ left: number; top: number } | null>(null);

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
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  // Enter on Cancel or Apply is the button's own.
  if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault();
    apply();
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

function onPointerDownOutside(event: PointerEvent): void {
  if (!root.value || !(event.target instanceof Node)) return;
  if (root.value.contains(event.target) || props.anchor?.contains(event.target)) return;
  emit("close");
}

function place(): void {
  if (!root.value || !props.anchor) return;
  const size = root.value.getBoundingClientRect();
  const spot = hangFrom(
    props.anchor.getBoundingClientRect(),
    { width: size.width, height: size.height },
    viewportSize(),
  );
  box.value = { left: spot.left, top: spot.top };
}

function onResize(): void {
  void nextTick(place);
}

function onScroll(event: Event): void {
  if (event.target instanceof Node && root.value?.contains(event.target)) return;
  emit("close");
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  place();
  // After the select's list has closed and given its button the focus back.
  void nextTick(() => root.value?.querySelector("input")?.focus());
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  document.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
});
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
      <Button variant="ghost" @click="emit('close')">{{ t("dialog.cancel") }}</Button>
      <Button variant="primary" data-testid="pattern-apply" @click="apply">
        {{ t("graph.apply") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* As wide as the frame's popover (280px); not on the spacing scale. */
.pattern-popover {
  width: 280px;
}
</style>
