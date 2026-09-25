<script setup lang="ts">
// A font field of Appearance: the committed text field (Enter or blur applies, Escape restores
// and lets go) with the platform's suggestions that contain what is typed, in the app's list
// (OptionList) rather than the webview's datalist, whose list the platform draws unreadable in
// the dark theme. Typing, a click or Down opens the suggestions; Down and Up move, Enter takes
// the active one into the field and applies it, a click takes one, and Escape closes the list
// before it lets go of the field.

import { computed, ref, useId } from "vue";

import Input from "@/components/Input.vue";
import OptionList from "@/components/OptionList.vue";
import type { SelectOption } from "@/components/types";

import { useCommittedText } from "./useCommittedText";

const props = defineProps<{
  id: string;
  /** The stored value the field shows and restores. */
  stored: string;
  suggestions: readonly string[];
  placeholder: string;
  testid: string;
  label: string;
}>();
const emit = defineEmits<{ apply: [value: string] }>();

const field = useCommittedText(
  () => props.stored,
  (value) => emit("apply", value.trim().slice(0, 64)),
);

const input = ref<{ $el: HTMLElement } | null>(null);
const listId = useId();
const open = ref(false);
const active = ref(-1);

/** The suggestions that contain what is typed; all of them for an empty field. */
const matches = computed<SelectOption[]>(() => {
  const typed = field.draft.value.trim().toLowerCase();
  return props.suggestions
    .filter((name) => typed === "" || name.toLowerCase().includes(typed))
    .map((name) => ({ value: name, label: name }));
});

function show(): void {
  open.value = matches.value.length > 0;
}

function hide(): void {
  open.value = false;
  active.value = -1;
}

function take(index: number): void {
  const suggestion = matches.value[index];
  if (!suggestion) return;
  field.draft.value = suggestion.value;
  hide();
  field.commit();
}

function onInput(): void {
  active.value = -1;
  show();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!open.value) show();
    active.value = Math.min(active.value + 1, matches.value.length - 1);
    return;
  }
  if (event.key === "ArrowUp" && open.value) {
    event.preventDefault();
    active.value = Math.max(active.value - 1, 0);
    return;
  }
  if (event.key === "Enter" && open.value && active.value >= 0) {
    event.preventDefault();
    take(active.value);
    return;
  }
  if (event.key === "Escape" && open.value) {
    // The list goes first; the next Escape lets go of the field.
    event.preventDefault();
    event.stopPropagation();
    hide();
    return;
  }
  if (event.key === "Enter" || event.key === "Escape") hide();
  field.onKeydown(event);
}

function onBlur(): void {
  hide();
  field.commit();
}
</script>

<template>
  <Input
    :id="props.id"
    ref="input"
    v-model="field.draft.value"
    :placeholder="props.placeholder"
    spellcheck="false"
    role="combobox"
    aria-autocomplete="list"
    :aria-expanded="open"
    :aria-controls="open ? listId : undefined"
    :aria-activedescendant="open && active >= 0 ? `${listId}-${active}` : undefined"
    :data-testid="props.testid"
    @input="onInput"
    @click="open ? hide() : show()"
    @keydown="onKeydown"
    @blur="onBlur"
  />
  <OptionList
    v-if="open && input"
    :id="listId"
    :options="matches"
    :anchor="input.$el"
    :active="active"
    :label="props.label"
    @choose="take"
    @close="hide"
  />
</template>
