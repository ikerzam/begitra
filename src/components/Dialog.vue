<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useId, useTemplateRef, type Component } from "vue";
import { useI18n } from "vue-i18n";

import Button from "./Button.vue";
import Progress from "./Progress.vue";
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
    /** The confirmed action runs and cannot be stopped: the buttons, Escape and a press
     * outside do nothing, and a sweeping bar shows at the footer's start. */
    busy?: boolean;
    /** No confirm: a dialog that only informs closes with its cancel button, which has the
     * focus. */
    noConfirm?: boolean;
    /** The confirm takes the focus when the dialog opens, so ↵ runs it (a choice that loses
     * nothing); otherwise the first control has it. */
    focusConfirm?: boolean;
    /** Ids of the content that describes the dialog after its body (a list it names). */
    describedBy?: string[];
  }>(),
  {
    body: "",
    confirmLabel: "",
    cancelLabel: "",
    variant: "default",
    confirmDisabled: false,
    confirmIcon: undefined,
    size: "md",
    busy: false,
    noConfirm: false,
    focusConfirm: false,
    describedBy: () => [],
  },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const { t } = useI18n();

const panel = useTemplateRef<HTMLElement>("panel");
const titleId = useId();
const bodyId = `${titleId}-body`;
const trap = useFocusTrap(panel);

/** The body, then the content the caller names. */
const description = computed(
  () => [...(props.body ? [bodyId] : []), ...props.describedBy].join(" ") || undefined,
);

let previouslyFocused: Element | null = null;

/*
 * Escape cancels; Tab cycles inside the panel so focus never lands behind the scrim. Both
 * stop here: a dialog inside a sheet (a confirmation) must not close the sheet with it.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (!props.busy) emit("cancel");
    return;
  }
  if (trap.onKeydown(event)) event.stopPropagation();
}

/*
 * A control that turns disabled while it has the focus (a busy footer, a button whose work
 * runs) drops it to the page's body, out of the panel's keys: Escape, the Tab trap and the
 * shortcuts' check for an open dialog stop working. The panel takes it back. A window that
 * loses the focus keeps its focused control, which is left alone.
 */
function onFocusout(event: FocusEvent): void {
  if (event.relatedTarget !== null) return;
  setTimeout(() => {
    const active = document.activeElement;
    if (panel.value && (active === null || active === document.body)) panel.value.focus();
  }, 0);
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
  <Scrim class="z-20" data-testid="dialog-scrim" @dismiss="() => !props.busy && emit('cancel')">
    <div
      ref="panel"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-labelledby="titleId"
      :aria-describedby="description"
      :data-variant="props.variant"
      :data-size="props.size"
      :aria-busy="props.busy ? 'true' : undefined"
      class="dialog flex flex-col gap-4 rounded-lg border border-line-strong bg-raised p-5 shadow-overlay"
      @keydown="onKeydown"
      @focusout="onFocusout"
    >
      <h2 :id="titleId" class="shrink-0 text-xl font-semibold text-fg">{{ props.title }}</h2>
      <!-- The content scrolls between the title and the buttons when the window is too short for
           it: a grid of rows as tall as their content, so a list that scrolls itself keeps its
           height rather than shrink to nothing (its automatic minimum is 0); 4px inside its
           edges keep the focus rings of its controls. -->
      <div
        v-if="props.body || $slots.default"
        class="-m-1 grid min-h-0 auto-rows-max grid-cols-1 gap-4 overflow-y-auto p-1"
        data-testid="dialog-content"
      >
        <p v-if="props.body" :id="bodyId" class="text-md text-fg-secondary">{{ props.body }}</p>
        <slot />
      </div>
      <!-- A confirm too long for the row (a long branch name) takes a row of its own and
           truncates, so the footer stays inside the panel. -->
      <div class="mt-2 flex shrink-0 flex-wrap items-center justify-end gap-2">
        <!-- An action of its own at the start of the footer ("Add repository…", "Delete project…"). -->
        <div v-if="$slots['footer-start']" class="mr-auto flex items-center">
          <slot name="footer-start" />
        </div>
        <Progress
          v-else-if="props.busy"
          class="dialog-busy mr-auto"
          indeterminate
          :label="props.confirmLabel"
          data-testid="dialog-busy"
        />
        <!-- A dialog with no confirm closes on ↵: its cancel takes the focus. -->
        <Button
          size="lg"
          variant="secondary"
          :disabled="props.busy"
          :data-autofocus="props.noConfirm ? '' : undefined"
          data-testid="dialog-cancel"
          @click="emit('cancel')"
        >
          {{ props.cancelLabel || t("dialog.cancel") }}
        </Button>
        <!-- Another way through, between cancel and confirm ("Leave them in a stash"). -->
        <slot name="actions" />
        <Button
          v-if="!props.noConfirm"
          size="lg"
          class="max-w-full"
          :variant="props.variant === 'destructive' ? 'destructive' : 'primary'"
          :disabled="props.confirmDisabled || props.busy"
          :icon="props.confirmIcon"
          :data-autofocus="props.focusConfirm ? '' : undefined"
          data-testid="dialog-confirm"
          @click="emit('confirm')"
        >
          <span class="min-w-0 truncate">{{ props.confirmLabel || t("dialog.confirm") }}</span>
        </Button>
      </div>
    </div>
  </Scrim>
</template>

<style scoped>
/* A dialog is 440px wide; it shrinks on narrow windows and keeps 16px from a short window's
   edges, its content scrolling. */
.dialog {
  width: 440px;
  max-width: calc(100vw - var(--space-6));
  max-height: calc(100vh - var(--space-6));
}
.dialog[data-size="lg"] {
  width: 560px;
}
.dialog[data-size="xl"] {
  width: 600px;
}
/* The busy bar is 48px, as a member row's during a bulk run. */
.dialog-busy {
  width: 48px;
}
</style>
