<script setup lang="ts">
import { X } from "@lucide/vue";
import { ref, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import Toast from "@/components/Toast.vue";
import { useToastsStore, type ToastEntry } from "@/stores/toasts";

const emit = defineEmits<{
  /** A toast holding the focus went (its action, its X, a newer one in its slot). */
  released: [];
}>();

const { t } = useI18n();
const toasts = useToastsStore();
const expanded = ref(new Set<number>());
const host = useTemplateRef<HTMLElement>("host");

// The focus on a toast's button falls to the page's body when the toast goes: the shell then
// gives it back to the layout shown.
let held = false;
watch(
  () => toasts.toasts,
  () => {
    held = host.value?.contains(document.activeElement) ?? false;
  },
  { flush: "pre" },
);
watch(
  () => toasts.toasts,
  () => {
    if (!held) return;
    held = false;
    const active = document.activeElement;
    if (active === null || active === document.body) emit("released");
  },
  { flush: "post" },
);

function toggle(id: number): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

/** The action: the toast's own, which takes it away, or the output toggle. */
function onAction(toast: ToastEntry): void {
  if (toast.onAction) toasts.act(toast.id);
  else toggle(toast.id);
}

function messageOf(toast: ToastEntry): string {
  if (!toast.key) return toast.message;
  const params = toast.params ?? {};
  // A count `n` picks the message's plural form ("Cherry-picked 2 commits"), given as a number
  // or as the string a store formats; vue-i18n reads only a number.
  const n = typeof params["n"] === "string" ? Number(params["n"]) : params["n"];
  return typeof n === "number" && Number.isInteger(n)
    ? t(toast.key, params, n)
    : t(toast.key, params);
}

function actionOf(toast: ToastEntry): string {
  return toast.actionKey ? t(toast.actionKey) : (toast.action ?? "");
}
</script>

<template>
  <div
    ref="host"
    class="toast-host pointer-events-none absolute right-4 left-4 z-50 flex flex-col items-end gap-2"
    data-testid="toast-host"
  >
    <div
      v-for="toast in toasts.toasts"
      :key="toast.id"
      class="pointer-events-auto flex flex-col items-end gap-1"
    >
      <div class="flex items-center gap-1">
        <Toast
          :kind="toast.kind"
          :message="messageOf(toast)"
          :action="actionOf(toast)"
          :output="toast.output"
          @action="onAction(toast)"
        />
        <IconButton :label="t('toast.dismiss')" :icon="X" @click="toasts.dismiss(toast.id)" />
      </div>
      <!-- A toast whose action does something else shows its output at once. -->
      <pre
        v-if="(expanded.has(toast.id) || toast.onAction) && toast.output"
        class="toast-output max-w-full overflow-auto rounded-md border border-line bg-raised p-3 font-mono text-mono-sm whitespace-pre-wrap text-fg-secondary select-text"
        data-testid="toast-output"
        >{{ toast.output }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* 16px above the status bar, clear of its hints. */
.toast-host {
  bottom: calc(var(--bar-status) + var(--space-4));
}

/* The raw output block of a toast: 480px wide like the palette and the command box of the top
   bar, at most 240px tall before it scrolls; neither is on the spacing scale. */
.toast-output {
  width: 480px;
  max-height: 240px;
}
</style>
