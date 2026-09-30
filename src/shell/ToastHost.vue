<script setup lang="ts">
import { X } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import Toast from "@/components/Toast.vue";
import { useToastsStore, type ToastEntry } from "@/stores/toasts";

const { t } = useI18n();
const toasts = useToastsStore();
const expanded = ref(new Set<number>());

function toggle(id: number): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

/** The action: the toast's own, which dismisses it, or the output toggle. */
function onAction(toast: ToastEntry): void {
  if (toast.onAction) {
    toasts.dismiss(toast.id);
    toast.onAction();
  } else {
    toggle(toast.id);
  }
}

function messageOf(toast: ToastEntry): string {
  return toast.key ? t(toast.key, toast.params ?? {}) : toast.message;
}

function actionOf(toast: ToastEntry): string {
  return toast.actionKey ? t(toast.actionKey) : (toast.action ?? "");
}
</script>

<template>
  <div
    class="pointer-events-none absolute right-4 bottom-6 left-4 z-50 flex flex-col items-end gap-2"
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
/* The raw output block of a toast: 480px wide like the palette and the command box of the top
   bar, at most 240px tall before it scrolls; neither is on the spacing scale. */
.toast-output {
  width: 480px;
  max-height: 240px;
}
</style>
