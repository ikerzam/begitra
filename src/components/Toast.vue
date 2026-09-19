<script setup lang="ts">
import { Check, CircleAlert, Info } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "./Button.vue";
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
    class="inline-flex items-center gap-3 rounded-lg border border-line-strong bg-raised py-1 pl-3 text-md text-fg shadow-overlay"
    :class="actionLabel ? 'pr-1' : 'pr-3'"
  >
    <component
      :is="icons[props.kind]"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="shrink-0"
      :class="iconClasses[props.kind]"
    />
    <span class="whitespace-nowrap">{{ props.message }}</span>
    <Button v-if="actionLabel" variant="ghost" data-testid="toast-action" @click="emit('action')">
      {{ actionLabel }}
    </Button>
  </div>
</template>
