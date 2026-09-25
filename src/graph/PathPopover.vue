<script setup lang="ts">
// The popover of the Path filter: one repository-relative path (a file or a directory) and
// Apply; Enter applies, Escape and a click outside close, an empty value clears the filter.

import { nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import { fitSide, viewportSize } from "@/components/placement";

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
/* Lined up with the button's left edge, or its right one when the left would leave the window. */
const align = ref<"start" | "end">("start");

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

/** From the button's left edge, turned to its right one when the popover would leave the window. */
function place(): void {
  if (!root.value || !props.anchor) return;
  align.value = fitSide(
    root.value.getBoundingClientRect(),
    props.anchor.getBoundingClientRect(),
    { align: align.value, placement: "bottom" },
    viewportSize(),
  ).align;
}

function onResize(): void {
  align.value = "start";
  void nextTick(place);
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  window.addEventListener("resize", onResize);
  place();
  root.value?.querySelector("input")?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <div
    ref="root"
    role="dialog"
    :aria-label="t('graph.pathFilter')"
    :class="align === 'end' ? 'right-0' : 'left-0'"
    class="path-popover absolute top-full z-20 mt-1 flex flex-col gap-2 rounded-lg border border-line-strong bg-raised p-2 shadow-overlay"
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
