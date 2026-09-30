<script setup lang="ts">
// A select in the app's own treatment: a button with the value and the chevron that opens the
// options in an OptionList, the control showing its open state (the focus border, the chevron
// up). The keys of the WAI-ARIA select-only combobox: closed, the arrows, Enter, Space
// and F4 open it (a letter does not, so j and k keep walking the settings' fields); open, the
// arrows, Home, End and Page Up/Down move, letters jump to the next option they start (a space
// inside a typed run is part of it), Enter, Space, F4 and Alt with an arrow choose, Tab chooses
// and moves on, and Escape closes without choosing; the keys it handles while open stop here,
// so Escape never closes the dialog around it. The list closes when the focus leaves, and a
// press outside it only closes it, as the platform's select.

import { ChevronDown, ChevronUp } from "@lucide/vue";
import { computed, ref, useId, watch } from "vue";

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
/** The list's name: the control's own, or the text of the label that points at it. */
const listLabel = ref<string | undefined>(undefined);

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

/** The chosen option when it can be marked, else the first enabled one. */
function initialRow(): number {
  return enabled(selectedIndex.value) ? selectedIndex.value : step(-1, 1);
}

function show(): void {
  if (props.disabled) return;
  current.value = initialRow();
  listLabel.value = props.label ?? button.value?.labels?.[0]?.textContent?.trim() ?? undefined;
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

/* Options that change while the list is open (a reload re-sorts the authors) keep the marked
   one by its value, not by its place. */
watch(
  () => props.options,
  (options, previous) => {
    if (!open.value) return;
    const value = previous[current.value]?.value;
    const index = options.findIndex((option) => option.value === value);
    current.value = index >= 0 && enabled(index) ? index : initialRow();
  },
);

/* Typing jumps to the next option that starts with the letters typed within half a second;
   one letter again moves on to the next that starts with it. */
let typed = "";
let typedAt = 0;

function typing(): boolean {
  return typed !== "" && Date.now() - typedAt <= 500;
}

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
    if (["ArrowDown", "ArrowUp", "Enter", " ", "F4"].includes(event.key)) {
      event.preventDefault();
      show();
    }
    return;
  }
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp":
      if (event.altKey) choose(current.value);
      else current.value = step(current.value, event.key === "ArrowDown" ? 1 : -1);
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
    case " ":
      if (typing()) typeahead(" ");
      else choose(current.value);
      break;
    case "Enter":
    case "F4":
      choose(current.value);
      break;
    case "Escape":
      hide();
      break;
    case "Tab":
      // Chooses and lets the focus move on; with nothing to choose it only closes.
      if (enabled(current.value)) choose(current.value, false);
      else hide();
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
      @blur="hide"
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
      :label="listLabel"
      modal
      @choose="(index) => choose(index)"
      @close="hide"
    />
  </div>
</template>

<style scoped>
/* The open state: the focus colour as a 2px ring over the border, as a focused input,
   drawn as the outline so the keyboard's focus ring cannot add to it. */
.select-open {
  outline: 2px solid var(--focus-ring);
  outline-offset: -1px;
}
</style>
