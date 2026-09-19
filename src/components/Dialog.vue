<script setup lang="ts">
import { onBeforeUnmount, onMounted, useId, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "./Button.vue";

const props = withDefaults(
  defineProps<{
    title: string;
    /** For a destructive dialog: the consequence and the way back, when Git has one. */
    body?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: "default" | "destructive";
    confirmDisabled?: boolean;
  }>(),
  { body: "", confirmLabel: "", cancelLabel: "", variant: "default", confirmDisabled: false },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const { t } = useI18n();

const panel = useTemplateRef<HTMLElement>("panel");
const titleId = useId();
const bodyId = `${titleId}-body`;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let previouslyFocused: Element | null = null;

function focusables(): HTMLElement[] {
  const nodes = panel.value?.querySelectorAll<HTMLElement>(FOCUSABLE);
  return nodes ? Array.from(nodes) : [];
}

/* Escape cancels; Tab cycles inside the panel so focus never lands behind the scrim. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("cancel");
    return;
  }
  if (event.key !== "Tab") return;
  const list = focusables();
  const first = list[0];
  const last = list[list.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  previouslyFocused = document.activeElement;
  const target =
    panel.value?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0] ?? panel.value;
  target?.focus();
});

onBeforeUnmount(() => {
  if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
});
</script>

<template>
  <div
    data-testid="dialog-scrim"
    class="fixed inset-0 z-10 flex items-center justify-center bg-shadow"
    @pointerdown.self="emit('cancel')"
  >
    <div
      ref="panel"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-labelledby="titleId"
      :aria-describedby="props.body ? bodyId : undefined"
      :data-variant="props.variant"
      class="dialog flex flex-col gap-4 rounded-lg border border-line-strong bg-raised p-5 shadow-overlay"
      @keydown="onKeydown"
    >
      <h2 :id="titleId" class="text-xl font-semibold text-fg">{{ props.title }}</h2>
      <p v-if="props.body" :id="bodyId" class="text-md text-fg-secondary">{{ props.body }}</p>
      <slot />
      <div class="mt-2 flex justify-end gap-2">
        <Button size="lg" variant="secondary" data-testid="dialog-cancel" @click="emit('cancel')">
          {{ props.cancelLabel || t("dialog.cancel") }}
        </Button>
        <Button
          size="lg"
          :variant="props.variant === 'destructive' ? 'destructive' : 'primary'"
          :disabled="props.confirmDisabled"
          data-testid="dialog-confirm"
          @click="emit('confirm')"
        >
          {{ props.confirmLabel || t("dialog.confirm") }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A dialog is 440px wide; it shrinks on narrow windows. */
.dialog {
  width: 440px;
  max-width: calc(100vw - var(--space-6));
}
</style>
