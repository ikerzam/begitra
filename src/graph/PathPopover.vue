<script setup lang="ts">
// The popover of the Path filter: one repository-relative path (a file or a directory) and
// Apply; Enter applies, Escape, a press or a scroll outside and the focus leaving close, an empty
// value clears the filter. Hangs under its button (`useAnchoredPopover`).

import { ref, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import { useAnchoredPopover } from "@/components/useAnchoredPopover";

const props = defineProps<{
  /** The path currently filtering, shown as the initial value. */
  path: string;
  /** The button that opened the popover; clicks on it do not count as outside. */
  anchor?: HTMLElement | null;
}>();
/** `close`'s `refocus` is false when the focus already went elsewhere. */
const emit = defineEmits<{ apply: [path: string]; close: [refocus: boolean] }>();

const { t } = useI18n();
const root = useTemplateRef<HTMLElement>("root");
const value = ref(props.path);
const { box, onFocusOut } = useAnchoredPopover(
  root,
  () => props.anchor,
  (refocus) => emit("close", refocus),
  (popover) => popover.querySelector("input")?.focus(),
);

function apply(): void {
  emit("apply", value.value.trim());
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
    :aria-label="t('graph.pathFilter')"
    :style="
      box
        ? { left: `${box.left}px`, top: `${box.top}px` }
        : { left: '0', top: '0', visibility: 'hidden' }
    "
    class="path-popover fixed z-20 flex flex-col gap-2 rounded-lg border border-line-strong bg-raised p-2 shadow-overlay"
    data-testid="path-popover"
    @keydown="onKeydown"
    @focusout="onFocusOut"
  >
    <Input v-model="value" :placeholder="t('graph.pathPlaceholder')" spellcheck="false" />
    <div class="flex justify-end gap-2">
      <Button variant="ghost" @click="emit('close', true)">{{ t("dialog.cancel") }}</Button>
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
