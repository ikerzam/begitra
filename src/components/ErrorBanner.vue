<script setup lang="ts">
import { ChevronDown, ChevronRight, CircleAlert } from "@lucide/vue";
import { ref, useId } from "vue";
import { useI18n } from "vue-i18n";

import Button from "./Button.vue";

const props = withDefaults(
  defineProps<{
    /** What happened and what to do, in the interface's voice. */
    message: string;
    /** Raw git output behind the disclosure. */
    output?: string;
    /** Label of the optional secondary action. */
    action?: string;
    /** Start with the git output expanded. */
    open?: boolean;
  }>(),
  { output: "", action: "", open: false },
);

const emit = defineEmits<{ action: [] }>();

const { t } = useI18n();

const expanded = ref(props.open);
const outputId = useId();
</script>

<template>
  <div role="alert" class="flex flex-col gap-3 rounded-md border border-line-strong p-4 text-md">
    <div class="flex items-start gap-3">
      <CircleAlert
        :size="16"
        :stroke-width="1.5"
        aria-hidden="true"
        class="mt-px shrink-0 text-danger"
      />
      <p class="min-w-0 flex-1 text-fg">{{ props.message }}</p>
      <Button v-if="props.action" variant="secondary" class="shrink-0" @click="emit('action')">
        {{ props.action }}
      </Button>
    </div>
    <div v-if="props.output" class="flex items-start gap-3">
      <span aria-hidden="true" class="w-icon shrink-0" />
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <button
          type="button"
          :aria-expanded="expanded"
          :aria-controls="outputId"
          data-testid="error-banner-toggle"
          class="inline-flex items-center gap-2 self-start text-fg-secondary hover:text-fg"
          @click="expanded = !expanded"
        >
          <component
            :is="expanded ? ChevronDown : ChevronRight"
            :size="12"
            :stroke-width="1.5"
            aria-hidden="true"
          />
          {{ expanded ? t("errorBanner.hideGitOutput") : t("errorBanner.showGitOutput") }}
        </button>
        <pre
          v-if="expanded"
          :id="outputId"
          data-testid="error-banner-output"
          class="overflow-x-auto font-mono text-code whitespace-pre text-fg-secondary"
          >{{ props.output }}</pre>
      </div>
    </div>
  </div>
</template>
