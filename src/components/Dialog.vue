<script setup lang="ts">
import { onBeforeUnmount, onMounted, useId, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "./Button.vue";
import { useFocusTrap } from "./useFocusTrap";

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
const trap = useFocusTrap(panel);

let previouslyFocused: Element | null = null;

/* Escape cancels; Tab cycles inside the panel so focus never lands behind the scrim. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("cancel");
    return;
  }
  trap.onKeydown(event);
}

onMounted(() => {
  previouslyFocused = document.activeElement;
  const target =
    panel.value?.querySelector<HTMLElement>("[data-autofocus]") ??
    trap.focusables()[0] ??
    panel.value;
  target?.focus();
});

onBeforeUnmount(() => {
  if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
});
</script>

<template>
  <div
    data-testid="dialog-scrim"
    class="dialog-scrim fixed z-10 flex items-center justify-center bg-shadow"
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
/* The strict spacing scale generates no `inset-0`, so the scrim covers the window from here. */
.dialog-scrim {
  inset: 0;
}

/* A dialog is 440px wide; it shrinks on narrow windows. */
.dialog {
  width: 440px;
  max-width: calc(100vw - var(--space-6));
}
</style>
