<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    /** Accessible name of the menu. */
    label?: string;
    /** Viewport position; when both are given the menu is fixed there. */
    x?: number;
    y?: number;
    /** An element whose clicks do not count as outside (the button that toggles the menu). */
    anchor?: HTMLElement | null;
  }>(),
  { label: "", x: undefined, y: undefined, anchor: null },
);

/** `close` fires on Escape, Tab, a click outside, or after an item is activated. */
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const root = useTemplateRef<HTMLElement>("root");

const positioned = computed(() => props.x !== undefined && props.y !== undefined);

function items(): HTMLElement[] {
  const nodes = root.value?.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not([aria-disabled="true"])',
  );
  return nodes ? Array.from(nodes) : [];
}

function currentIndex(): number {
  const active = document.activeElement;
  return active instanceof HTMLElement ? items().indexOf(active) : -1;
}

function focusItem(index: number): void {
  const list = items();
  if (list.length === 0) return;
  const wrapped = ((index % list.length) + list.length) % list.length;
  list[wrapped]?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  const current = currentIndex();
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      focusItem(current + 1);
      break;
    case "ArrowUp":
      event.preventDefault();
      focusItem(current < 0 ? -1 : current - 1);
      break;
    case "Home":
      event.preventDefault();
      focusItem(0);
      break;
    case "End":
      event.preventDefault();
      focusItem(-1);
      break;
    case "Escape":
      event.preventDefault();
      emit("close");
      break;
    case "Tab":
      emit("close");
      break;
  }
}

function onClick(event: MouseEvent): void {
  if (!(event.target instanceof HTMLElement)) return;
  const item = event.target.closest('[role="menuitem"]');
  if (item && item.getAttribute("aria-disabled") !== "true") emit("close");
}

function onPointerDownOutside(event: PointerEvent): void {
  if (!root.value || !(event.target instanceof Node)) return;
  if (root.value.contains(event.target) || props.anchor?.contains(event.target)) return;
  emit("close");
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  focusItem(0);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
});
</script>

<template>
  <div
    ref="root"
    role="menu"
    tabindex="-1"
    :aria-label="props.label || t('contextMenu.label')"
    class="context-menu flex flex-col rounded-lg border border-line-strong bg-raised p-1 shadow-overlay"
    :class="{ 'fixed z-10': positioned }"
    :style="positioned ? { left: `${props.x}px`, top: `${props.y}px` } : undefined"
    @keydown="onKeydown"
    @click="onClick"
  >
    <slot />
  </div>
</template>

<style scoped>
/* A context menu is at least 220px wide. */
.context-menu {
  min-width: 220px;
}
</style>
