<script setup lang="ts">
// A wide dialog for a list with its own actions (the remotes and the stash sheets): a title
// with a count and the header's actions, the body, a footer sentence and "Close". Same scrim
// and focus rules as `Dialog`; both sheets are 640px wide.

import { X } from "@lucide/vue";
import { onBeforeUnmount, onMounted, useId, useTemplateRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "./Button.vue";
import IconButton from "./IconButton.vue";
import Scrim from "./Scrim.vue";
import { useFocusTrap } from "./useFocusTrap";

const props = withDefaults(
  defineProps<{
    title: string;
    count?: number;
    /** The sentence under the list. */
    footer?: string;
    /** "Close" as a button in the footer (the remotes sheet) or as the header's icon (the stash sheet). */
    closeAs?: "button" | "icon";
  }>(),
  { count: undefined, footer: "", closeAs: "button" },
);

const emit = defineEmits<{ close: [] }>();

const { t, n } = useI18n();

const panel = useTemplateRef<HTMLElement>("panel");
const titleId = useId();
const trap = useFocusTrap(panel);

let previouslyFocused: Element | null = null;

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
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
  <Scrim class="z-10" data-testid="sheet-scrim" @dismiss="emit('close')">
    <div
      ref="panel"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-labelledby="titleId"
      class="sheet flex flex-col rounded-lg border border-line-strong bg-raised shadow-overlay"
      @keydown="onKeydown"
    >
      <header class="flex items-center gap-2 border-b border-line px-5 py-3">
        <h2 :id="titleId" class="text-lg font-semibold text-fg">{{ props.title }}</h2>
        <span
          v-if="props.count !== undefined"
          class="text-md text-fg-muted"
          data-testid="sheet-count"
        >
          {{ n(props.count) }}
        </span>
        <div class="ml-auto flex items-center gap-2">
          <slot name="actions" />
          <IconButton
            v-if="props.closeAs === 'icon'"
            :label="t('sheet.close')"
            :icon="X"
            data-testid="sheet-close"
            @click="emit('close')"
          />
        </div>
      </header>
      <div class="sheet-body min-h-0 overflow-y-auto">
        <slot />
      </div>
      <footer
        v-if="props.footer || props.closeAs === 'button'"
        class="flex items-center gap-3 border-t border-line px-5 py-3"
      >
        <p v-if="props.footer" class="min-w-0 flex-1 text-sm text-fg-muted">{{ props.footer }}</p>
        <Button
          v-if="props.closeAs === 'button'"
          variant="secondary"
          class="ml-auto"
          data-testid="sheet-close"
          @click="emit('close')"
        >
          {{ t("sheet.close") }}
        </Button>
      </footer>
    </div>
  </Scrim>
</template>

<style scoped>
/* The remotes and stash sheets are 640px wide; the body scrolls past 480px. */
.sheet {
  width: 640px;
  max-width: calc(100vw - var(--space-6));
}

.sheet-body {
  max-height: 480px;
}
</style>
