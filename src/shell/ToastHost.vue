<script setup lang="ts">
import { X } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import Toast from "@/components/Toast.vue";
import { useToastsStore } from "@/stores/toasts";

const { t } = useI18n();
const toasts = useToastsStore();
const expanded = ref(new Set<number>());

function toggle(id: number): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
</script>

<template>
  <div
    class="pointer-events-none absolute right-4 bottom-6 z-50 flex flex-col items-end gap-2"
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
          :message="toast.message"
          :action="toast.action"
          :output="toast.output"
          @action="toggle(toast.id)"
        />
        <IconButton :label="t('toast.dismiss')" :icon="X" @click="toasts.dismiss(toast.id)" />
      </div>
      <pre
        v-if="expanded.has(toast.id) && toast.output"
        class="toast-output max-w-full overflow-auto rounded-md border border-line bg-raised p-3 font-mono text-mono-sm whitespace-pre-wrap text-fg-secondary"
        data-testid="toast-output"
        >{{ toast.output }}</pre>
    </div>
  </div>
</template>

<style scoped>
.toast-output {
  width: 480px;
  max-height: 240px;
}
</style>
