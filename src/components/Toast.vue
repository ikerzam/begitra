<script setup lang="ts">
import { Check, CircleAlert, Info } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import type { ToastKind } from "./types";

const props = withDefaults(
  defineProps<{
    kind?: ToastKind;
    message: string;
    /** Action label. Defaults to "Show git output" when `output` is given. */
    action?: string;
    /** Raw git (or command) output behind the action; the owner decides where to show it. */
    output?: string;
  }>(),
  { kind: "info", action: "", output: "" },
);

const emit = defineEmits<{ action: [] }>();

const { t } = useI18n();

const icons = { success: Check, error: CircleAlert, info: Info } as const;

const iconClasses: Record<ToastKind, string> = {
  success: "text-ok",
  error: "text-danger",
  info: "text-info",
};

const actionLabel = computed(() => props.action || (props.output ? t("toast.showGitOutput") : ""));
</script>

<template>
  <div
    :role="props.kind === 'error' ? 'alert' : 'status'"
    :data-kind="props.kind"
    class="toast inline-flex items-center gap-3 rounded-lg border border-line-strong bg-raised px-3 py-2 text-md text-fg shadow-overlay"
  >
    <component
      :is="icons[props.kind]"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="shrink-0"
      :class="iconClasses[props.kind]"
    />
    <span class="min-w-0 break-words" data-testid="toast-message">{{ props.message }}</span>
    <!-- The action is 12px secondary text without button chrome; it is still a real button. -->
    <button
      v-if="actionLabel"
      type="button"
      data-testid="toast-action"
      class="shrink-0 text-sm whitespace-nowrap text-fg-secondary hover:text-fg"
      @click="emit('action')"
    >
      {{ actionLabel }}
    </button>
  </div>
</template>

<style scoped>
/* A long message wraps before the toast reaches half a wide window; the host keeps it inside a narrow one. */
.toast {
  max-width: 560px;
}
</style>
