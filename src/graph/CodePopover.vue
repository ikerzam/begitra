<script setup lang="ts">
// The popover of the Code filter: a text searched in what the commits change, "Added or removed"
// (`git log -S`, the default) or "On a changed line" (`git log -G`), and Apply; Enter applies,
// Escape, a press or a scroll outside and the focus leaving close. The text goes as typed: the
// graph store's `setCode` cleans it, and a blank one clears the search. Hangs under its button
// (`useAnchoredPopover`).

import { computed, ref, useId, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import RadioGroup from "@/components/RadioGroup.vue";
import type { RadioOption } from "@/components/types";
import { useAnchoredPopover } from "@/components/useAnchoredPopover";
import { MAX_CODE_TEXT } from "@/ipc/schemas";
import type { CodeSearch } from "@/stores/graph";

const props = defineProps<{
  /** The search the filter holds, shown as the initial value; null for none. */
  code: CodeSearch | null;
  /** The button that opened the popover; presses on it do not count as outside. */
  anchor?: HTMLElement | null;
}>();
/** `close`'s `refocus` is false when the focus already went elsewhere. */
const emit = defineEmits<{ apply: [code: CodeSearch]; close: [refocus: boolean] }>();

const ADDED = "added";
const LINES = "lines";

const { t } = useI18n();
const root = useTemplateRef<HTMLElement>("root");
const titleId = useId();
const value = ref(props.code?.text ?? "");
const mode = ref(props.code?.lines ? LINES : ADDED);
const { box, onFocusOut } = useAnchoredPopover(
  root,
  () => props.anchor,
  (refocus) => emit("close", refocus),
  (popover) => {
    const input = popover.querySelector<HTMLInputElement>('input[type="text"]');
    input?.focus();
    input?.select();
  },
);

/** git's own flag beside each choice, for whoever knows it. */
const choices = computed<RadioOption[]>(() => [
  { value: ADDED, label: t("graph.codeAdded"), hint: "-S", hintMono: true },
  { value: LINES, label: t("graph.codeLines"), hint: "-G", hintMono: true },
]);

function apply(): void {
  emit("apply", { text: value.value, lines: mode.value === LINES });
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
    :aria-labelledby="titleId"
    :style="
      box
        ? { left: `${box.left}px`, top: `${box.top}px` }
        : { left: '0', top: '0', visibility: 'hidden' }
    "
    class="code-popover fixed z-20 flex flex-col gap-2 rounded-lg border border-line-strong bg-raised p-3 shadow-overlay"
    data-testid="code-popover"
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <span :id="titleId" class="text-sm text-fg-secondary">{{ t("graph.codeTitle") }}</span>
    <Input
      v-model="value"
      :placeholder="t('graph.codePlaceholder')"
      spellcheck="false"
      autocomplete="off"
      :maxlength="MAX_CODE_TEXT"
      :aria-labelledby="titleId"
      data-testid="code-input"
    />
    <RadioGroup v-model="mode" :options="choices" :label="t('graph.codeMatch')" />
    <div class="flex justify-end gap-2">
      <Button variant="ghost" @click="emit('close', true)">{{ t("dialog.cancel") }}</Button>
      <Button variant="primary" data-testid="code-apply" @click="apply">
        {{ t("graph.apply") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* 280px wide, as the pattern's popover; not on the spacing scale. */
.code-popover {
  width: 280px;
}
</style>
