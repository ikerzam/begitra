<script setup lang="ts">
// A select in the app's own treatment: a button with the value and the chevron that
// opens the options in an OptionList, with its own open state (the focus border, the
// chevron up). The keys of the WAI-ARIA select-only combobox: closed, the arrows, Enter and
// Space open it (a letter does not, so j and k keep walking the settings' fields); open, the
// arrows, Home, End and Page Up/Down move, letters jump to the next option they start, Enter
// and Space choose, Tab chooses and moves on, and Escape closes without choosing; the keys it
// handles while open stop here, so Escape never closes the dialog around it.

import { ChevronDown, ChevronUp } from "@lucide/vue";
import { computed, ref, useId } from "vue";

import OptionList from "./OptionList.vue";
import type { ControlSize, SelectOption } from "./types";

const props = withDefaults(
  defineProps<{
    options: SelectOption[];
    /** The `id` of the control itself, for a `<label for>`. */
    id?: string;
    /** Accessible name when no visible label element points at the control. */
    label?: string;
    disabled?: boolean;
    size?: ControlSize;
    /** A control whose value narrows something is filled with `--bg-selected`. */
    active?: boolean;
  }>(),
  { id: undefined, label: undefined, disabled: false, size: "md", active: false },
);

const model = defineModel<string>({ default: "" });

const listId = useId();
const button = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const current = ref(-1);

const selectedIndex = computed(() =>
  props.options.findIndex((option) => option.value === model.value),
);
const selectedLabel = computed(() => props.options[selectedIndex.value]?.label ?? "");

function enabled(index: number): boolean {
  const option = props.options[index];
  return option !== undefined && !option.disabled;
}

/** The nearest enabled option past `from` going `step`, or `from` at the end. */
function step(from: number, direction: 1 | -1, count = 1): number {
  let found = from;
  let left = count;
  for (
    let index = from + direction;
    index >= 0 && index < props.options.length;
    index += direction
  ) {
    if (!enabled(index)) continue;
    found = index;
    left -= 1;
    if (left === 0) break;
  }
  return found;
}

function show(): void {
  if (props.disabled) return;
  current.value = enabled(selectedIndex.value) ? selectedIndex.value : step(-1, 1);
  open.value = true;
}

function hide(): void {
  open.value = false;
  typed = "";
}

function choose(index: number, refocus = true): void {
  if (!enabled(index)) return;
  const option = props.options[index];
  if (option) model.value = option.value;
  hide();
  if (refocus) button.value?.focus();
}

/* Typing jumps to the next option that starts with the letters typed within half a second;
   one letter again moves on to the next that starts with it. */
let typed = "";
let typedAt = 0;

function typeahead(char: string): void {
  const now = Date.now();
  typed = now - typedAt > 500 ? char : typed + char;
  typedAt = now;
  // The same letter again cycles through the options that start with it.
  const lower = typed.toLowerCase();
  const needle = /^(.)\1+$/u.test(lower) ? lower.charAt(0) : lower;
  const count = props.options.length;
  const from = needle.length === 1 ? current.value + 1 : Math.max(current.value, 0);
  for (let offset = 0; offset < count; offset += 1) {
    const index = (((from + offset) % count) + count) % count;
    const option = props.options[index];
    if (option && !option.disabled && option.label.toLowerCase().startsWith(needle)) {
      current.value = index;
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (!open.value) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      show();
    }
    return;
  }
  switch (event.key) {
    case "ArrowDown":
      current.value = step(current.value, 1);
      break;
    case "ArrowUp":
      current.value = step(current.value, -1);
      break;
    case "Home":
      current.value = step(-1, 1);
      break;
    case "End":
      current.value = step(props.options.length, -1);
      break;
    case "PageDown":
      current.value = step(current.value, 1, 10);
      break;
    case "PageUp":
      current.value = step(current.value, -1, 10);
      break;
    case "Enter":
    case " ":
      choose(current.value);
      break;
    case "Escape":
      hide();
      break;
    case "Tab":
      // Chooses and lets the focus move on.
      choose(current.value, false);
      return;
    default:
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      typeahead(event.key);
  }
  event.preventDefault();
  event.stopPropagation();
}
</script>

<template>
  <div class="relative inline-flex w-full items-center">
    <button
      :id="props.id"
      ref="button"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="open && current >= 0 ? `${listId}-${current}` : undefined"
      :aria-label="props.label"
      :disabled="props.disabled"
      class="flex w-full min-w-0 items-center rounded-sm border pr-6 pl-3 text-left text-md text-fg enabled:hover:bg-hover disabled:border-line disabled:text-fg-disabled"
      :class="[
        props.size === 'lg' ? 'h-6' : 'h-control',
        props.active ? 'bg-selected' : 'bg-app',
        open ? 'select-open border-focus' : 'border-line-strong',
      ]"
      :data-active="props.active ? 'true' : undefined"
      data-testid="select-button"
      @click="open ? hide() : show()"
      @keydown="onKeydown"
    >
      <span class="truncate">{{ selectedLabel }}</span>
    </button>
    <component
      :is="open ? ChevronUp : ChevronDown"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="pointer-events-none absolute right-3"
      :class="props.disabled ? 'text-fg-disabled' : 'text-fg-secondary'"
    />
    <OptionList
      v-if="open && button"
      :id="listId"
      :options="props.options"
      :anchor="button"
      :active="current"
      :selected="model"
      :label="props.label"
      @choose="(index) => choose(index)"
      @close="hide"
    />
  </div>
</template>

<style scoped>
/* The open state: the focus colour as a 2px border, as a focused input. */
.select-open {
  box-shadow: 0 0 0 1px var(--focus-ring);
}
</style>
