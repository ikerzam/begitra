<script setup lang="ts">
// The open list of a select or of a field's suggestions: options in the overlay treatment of
// the app's menus, fixed under its anchor (above it where the room under it is short), at
// least the anchor's width, the active row kept in view and the selected one checked. It
// never takes the focus: the control keeps it and names the active row through
// aria-activedescendant. A press outside it and its anchor, a scroll outside it and a window
// resize close it, as the platform's list does.

import { Check } from "@lucide/vue";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { EDGE, viewportSize } from "./placement";
import type { SelectOption } from "./types";

const props = withDefaults(
  defineProps<{
    /** The id of the listbox; each option's id is `<id>-<index>`. */
    id: string;
    options: readonly SelectOption[];
    /** The control the list hangs from. */
    anchor: HTMLElement;
    /** The row the keys point at; -1 for none. */
    active: number;
    /** The value shown as chosen, with its check; null for none (a field's suggestions). */
    selected?: string | null;
    /** Accessible name of the list. */
    label?: string;
  }>(),
  { selected: null, label: undefined },
);

const emit = defineEmits<{ choose: [index: number]; close: [] }>();

const list = ref<HTMLElement | null>(null);
const place = ref({ left: 0, top: 0, minWidth: 0 });

/** Under the anchor, or above it when the list fits there and not under. */
function measure(): void {
  const anchor = props.anchor.getBoundingClientRect();
  const height = list.value?.getBoundingClientRect().height ?? 0;
  const viewport = viewportSize();
  const below = anchor.bottom + 4;
  const above = anchor.top - 4 - height;
  const top = below + height > viewport.height - EDGE && above >= EDGE ? above : below;
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - EDGE - anchor.width));
  place.value = { left, top, minWidth: anchor.width };
}

function scrollActive(): void {
  const row = list.value?.children[props.active];
  if (row instanceof HTMLElement) row.scrollIntoView?.({ block: "nearest" });
}

function onPointerDownOutside(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (list.value?.contains(target) || props.anchor.contains(target)) return;
  emit("close");
}

function onScroll(event: Event): void {
  if (event.target instanceof Node && list.value?.contains(event.target)) return;
  emit("close");
}

function onResize(): void {
  emit("close");
}

watch(
  () => props.active,
  () => void nextTick(scrollActive),
);

onMounted(() => {
  measure();
  void nextTick(() => {
    measure();
    scrollActive();
  });
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  document.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <div
    :id="props.id"
    ref="list"
    role="listbox"
    :aria-label="props.label"
    class="option-list fixed z-50 flex flex-col overflow-y-auto rounded-lg border border-line-strong bg-raised p-1 shadow-overlay"
    :style="{
      left: `${place.left}px`,
      top: `${place.top}px`,
      minWidth: `${place.minWidth}px`,
    }"
    data-testid="option-list"
    @mousedown.prevent
  >
    <div
      v-for="(option, index) in props.options"
      :id="`${props.id}-${index}`"
      :key="option.value"
      role="option"
      :aria-selected="option.value === props.selected"
      :aria-disabled="option.disabled ? 'true' : undefined"
      :data-value="option.value"
      class="flex h-control w-full shrink-0 cursor-default items-center gap-2 rounded-sm px-2 text-md whitespace-nowrap"
      :class="[
        option.disabled ? 'text-fg-disabled' : 'text-fg',
        { 'bg-selected': index === props.active && !option.disabled },
      ]"
      data-testid="option"
      @click="!option.disabled && emit('choose', index)"
    >
      <span class="flex-1 truncate">{{ option.label }}</span>
      <Check
        v-if="option.value === props.selected"
        :size="16"
        :stroke-width="1.5"
        aria-hidden="true"
        class="shrink-0 text-fg-secondary"
      />
    </div>
  </div>
</template>

<style scoped>
/* The platform's list stops before the window does; ten rows show before it scrolls. */
.option-list {
  max-height: 320px;
}
</style>
