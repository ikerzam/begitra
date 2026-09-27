<script setup lang="ts">
import { onBeforeUnmount, onMounted, useId, useTemplateRef, type Component } from "vue";
import { useI18n } from "vue-i18n";

import Button from "./Button.vue";
import Scrim from "./Scrim.vue";
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
    /** Icon before the confirm label (the push dialog's upload arrow). */
    confirmIcon?: Component;
    /** 440px by default; the project dialogs' lists take 560 (a form) and 600 (a bulk
     * confirmation). */
    size?: "md" | "lg" | "xl";
  }>(),
  {
    body: "",
    confirmLabel: "",
    cancelLabel: "",
    variant: "default",
    confirmDisabled: false,
    confirmIcon: undefined,
    size: "md",
  },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const { t } = useI18n();

const panel = useTemplateRef<HTMLElement>("panel");
const titleId = useId();
const bodyId = `${titleId}-body`;
const trap = useFocusTrap(panel);

let previouslyFocused: Element | null = null;

/*
 * Escape cancels; Tab cycles inside the panel so focus never lands behind the scrim. Both
 * stop here: a dialog inside a sheet (a confirmation) must not close the sheet with it.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("cancel");
    return;
  }
  if (trap.onKeydown(event)) event.stopPropagation();
}

onMounted(() => {
  previouslyFocused = document.activeElement;
  trap.autofocusTarget()?.focus();
});

onBeforeUnmount(() => {
  if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
});
</script>

<template>
  <Scrim class="z-20" data-testid="dialog-scrim" @dismiss="emit('cancel')">
    <div
      ref="panel"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-labelledby="titleId"
      :aria-describedby="props.body ? bodyId : undefined"
      :data-variant="props.variant"
      :data-size="props.size"
      class="dialog flex flex-col gap-4 rounded-lg border border-line-strong bg-raised p-5 shadow-overlay"
      @keydown="onKeydown"
    >
      <h2 :id="titleId" class="text-xl font-semibold text-fg">{{ props.title }}</h2>
      <p v-if="props.body" :id="bodyId" class="text-md text-fg-secondary">{{ props.body }}</p>
      <slot />
      <div class="mt-2 flex items-center justify-end gap-2">
        <!-- An action of its own at the start of the footer ("Add repository…", "Delete project…"). -->
        <div v-if="$slots['footer-start']" class="mr-auto flex items-center">
          <slot name="footer-start" />
        </div>
        <Button size="lg" variant="secondary" data-testid="dialog-cancel" @click="emit('cancel')">
          {{ props.cancelLabel || t("dialog.cancel") }}
        </Button>
        <Button
          size="lg"
          :variant="props.variant === 'destructive' ? 'destructive' : 'primary'"
          :disabled="props.confirmDisabled"
          :icon="props.confirmIcon"
          data-testid="dialog-confirm"
          @click="emit('confirm')"
        >
          {{ props.confirmLabel || t("dialog.confirm") }}
        </Button>
      </div>
    </div>
  </Scrim>
</template>

<style scoped>
/* A dialog is 440px wide; it shrinks on narrow windows. */
.dialog {
  width: 440px;
  max-width: calc(100vw - var(--space-6));
}
.dialog[data-size="lg"] {
  width: 560px;
}
.dialog[data-size="xl"] {
  width: 600px;
}
</style>
