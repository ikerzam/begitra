<script setup lang="ts">
// The list a commit box helper opens from its button: a dialog in the overlay treatment of the
// app's menus, hanging above the button (`useHangingList`), its rows a label with a muted
// detail and an optional count. With `filter`, a field at its top keeps the focus while the
// arrows move the active row (aria-activedescendant), as the app's select does; without it the
// list takes the focus and j/k move too. Loading shows skeleton rows, a list without rows its
// empty sentence, a failure a line with git's output one click away. ↵ chooses the active row
// and Esc closes. The pointer's row takes --bg-hover and the keys' row --bg-selected, as in
// the menus.

import { computed, nextTick, onMounted, ref, useId, watch } from "vue";

import Input from "@/components/Input.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { AppError } from "@/ipc/errors";
import { arrowStep, rowStep } from "@/shortcuts/useListNavigation";

import HelperFailure from "./HelperFailure.vue";
import { useHangingList } from "./useHangingList";

export interface HelperRow {
  key: string;
  label: string;
  detail: string;
  count?: string;
}

const props = withDefaults(
  defineProps<{
    /** The button the list hangs from; its presses do not count as outside. */
    anchor: HTMLElement;
    /** The list's accessible name. */
    label: string;
    rows: readonly HelperRow[];
    state: "loading" | "ready" | "failed";
    /** What a ready list without rows says. */
    empty: string;
    error?: AppError | null;
    /** A field at the top filters the rows (`query`). */
    filter?: boolean;
    placeholder?: string;
    /** The list's width in pixels. */
    width?: number;
    testid: string;
  }>(),
  { error: null, filter: false, placeholder: "", width: 360 },
);
/** `close`'s `refocus` is false when the focus already went elsewhere. */
const emit = defineEmits<{ choose: [index: number]; close: [refocus: boolean] }>();
const query = defineModel<string>("query", { default: "" });

const id = useId();
const listId = `${id}-list`;
const panel = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);
const field = ref<{ $el: HTMLElement } | null>(null);
const active = ref(-1);
const showsRows = computed(() => props.state === "ready" && props.rows.length > 0);
const activeId = computed(() => (active.value >= 0 ? `${id}-${active.value}` : undefined));
const { place, measure, onFocusOut } = useHangingList(
  panel,
  () => props.anchor,
  (refocus) => emit("close", refocus),
);

/** The element the keys go to: the field, the list once it shows, else the panel itself. */
function keyTarget(): HTMLElement | null {
  if (props.filter) return field.value?.$el.querySelector("input") ?? null;
  return list.value ?? panel.value;
}

watch(
  () => [props.rows.length, props.state] as const,
  async () => {
    active.value = showsRows.value ? 0 : -1;
    await measure();
    // The rows came after the panel took the focus: the keys go to them now.
    if (document.activeElement === panel.value) keyTarget()?.focus();
  },
);
watch(active, (index) => {
  void nextTick(() => {
    document.getElementById(`${id}-${index}`)?.scrollIntoView?.({ block: "nearest" });
  });
});

function onKeydown(event: KeyboardEvent): void {
  // A key that ends an input method's composition is the composition's own.
  if (event.isComposing) return;
  if (event.key === "Escape") {
    // The screen behind does not see it.
    event.preventDefault();
    event.stopPropagation();
    emit("close", true);
    return;
  }
  // The output toggle's Enter and Space are its own.
  if (event.target instanceof HTMLButtonElement) return;
  const last = props.rows.length - 1;
  // In the field, j and k are letters.
  const step = props.filter ? arrowStep(event) : rowStep(event);
  if (step !== 0) {
    active.value = Math.min(last, Math.max(0, active.value + step));
  } else if (!props.filter && (event.key === "Home" || event.key === "End")) {
    active.value = event.key === "Home" ? Math.min(0, last) : last;
  } else if (event.key === "Enter" || (event.key === " " && !props.filter)) {
    if (active.value >= 0) emit("choose", active.value);
  } else {
    return;
  }
  event.preventDefault();
}

onMounted(() => {
  active.value = showsRows.value ? 0 : -1;
  keyTarget()?.focus();
});
</script>

<template>
  <div
    ref="panel"
    role="dialog"
    :aria-label="props.label"
    tabindex="-1"
    class="helper-list fixed z-20 flex flex-col gap-1 rounded-lg border border-line-strong bg-raised p-1 shadow-overlay outline-none"
    :style="{
      left: `${place.left}px`,
      top: `${place.top}px`,
      width: `${props.width}px`,
      maxHeight: place.height === null ? undefined : `${place.height}px`,
    }"
    :data-testid="props.testid"
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <Input
      v-if="props.filter"
      ref="field"
      v-model="query"
      :placeholder="props.placeholder"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="showsRows"
      :aria-controls="showsRows ? listId : undefined"
      :aria-activedescendant="activeId"
      :aria-label="props.label"
      spellcheck="false"
      autocomplete="off"
      :data-testid="`${props.testid}-filter`"
    />
    <div v-if="props.state === 'loading'" class="flex flex-col" aria-busy="true">
      <SkeletonRow v-for="k in 3" :key="k" :index="k" />
    </div>
    <HelperFailure v-else-if="props.state === 'failed'" :error="props.error" />
    <p v-else-if="props.rows.length === 0" role="status" class="px-2 py-1 text-sm text-fg-muted">
      {{ props.empty }}
    </p>
    <!-- A press on a row keeps the focus where it is: the field, or the list itself. -->
    <div
      v-else
      :id="listId"
      ref="list"
      role="listbox"
      class="helper-rows flex min-h-0 flex-col overflow-y-auto outline-none"
      :tabindex="props.filter ? -1 : 0"
      :aria-label="props.label"
      :aria-activedescendant="props.filter ? undefined : activeId"
      @mousedown.prevent
    >
      <div
        v-for="(row, index) in props.rows"
        :id="`${id}-${index}`"
        :key="row.key"
        role="option"
        :aria-selected="index === active"
        class="flex h-control w-full shrink-0 items-center gap-2 rounded-sm px-2 text-md"
        :class="index === active ? 'bg-selected' : 'hover:bg-hover'"
        data-testid="helper-row"
        @click="emit('choose', index)"
      >
        <span class="min-w-0 truncate text-fg">{{ row.label }}</span>
        <span class="min-w-0 flex-1 truncate text-sm text-fg-muted">{{ row.detail }}</span>
        <span v-if="row.count" class="shrink-0 text-sm text-fg-muted tabular-nums">
          {{ row.count }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The width the caller gives, never past the window's edges. */
.helper-list {
  max-width: calc(100vw - 2 * var(--space-2));
}
/* Ten rows, then the list scrolls. */
.helper-rows {
  max-height: calc(10 * var(--control));
}
</style>
