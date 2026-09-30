<script setup lang="ts">
// The popover of the Path filter: one repository-relative path (a file or a directory) and
// Apply; Enter applies, Escape and a click outside close, an empty value clears the filter.
// Fixed under its button (above it, or turned to its right edge, when the window is short of
// room), so the filter bar can scroll sideways without cutting it; a scroll outside closes it.

import { nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import { hangFrom, viewportSize } from "@/components/placement";

const props = defineProps<{
  /** The path currently filtering, shown as the initial value. */
  path: string;
  /** The button that opened the popover; clicks on it do not count as outside. */
  anchor?: HTMLElement | null;
}>();
const emit = defineEmits<{ apply: [path: string]; close: [] }>();

const { t } = useI18n();
const root = useTemplateRef<HTMLElement>("root");
const value = ref(props.path);
/* Where it hangs from the button; null until it is measured. */
const box = ref<{ left: number; top: number } | null>(null);

function apply(): void {
  emit("apply", value.value.trim());
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
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

/** Under the button from its left edge, as a select's options hang from the select. */
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
  root.value?.querySelector("input")?.focus();
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
    :aria-label="t('graph.pathFilter')"
    :style="
      box
        ? { left: `${box.left}px`, top: `${box.top}px` }
        : { left: '0', top: '0', visibility: 'hidden' }
    "
    class="path-popover fixed z-20 flex flex-col gap-2 rounded-lg border border-line-strong bg-raised p-2 shadow-overlay"
    data-testid="path-popover"
    @keydown="onKeydown"
  >
    <Input v-model="value" :placeholder="t('graph.pathPlaceholder')" spellcheck="false" />
    <div class="flex justify-end gap-2">
      <Button variant="ghost" @click="emit('close')">{{ t("dialog.cancel") }}</Button>
      <Button variant="primary" data-testid="path-apply" @click="apply">
        {{ t("graph.apply") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* The popover is as wide as the palette's narrow controls (320px); not on the spacing scale. */
.path-popover {
  width: 320px;
}
</style>
