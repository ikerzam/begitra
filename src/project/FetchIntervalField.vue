<script setup lang="ts">
// The Edit project dialog's "Fetch": how often the project's repositories fetch in the background
// while it is open, "Only by hand" until the user picks an interval, and what that means under
// the select.

import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";

import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import { fetchIntervals, intervalWords, type FetchInterval } from "@/stores/settings";

const model = defineModel<FetchInterval | null>({ required: true });

const { t } = useI18n();
const id = useId();
const hintId = useId();

/** The select's value for "Only by hand". */
const BY_HAND = "hand";

const options = computed<SelectOption[]>(() => [
  { value: BY_HAND, label: t("project.editDialog.fetch.byHand") },
  ...fetchIntervals.map((minutes) => ({
    value: String(minutes),
    label: t(`project.editDialog.fetch.${intervalWords(minutes)}`, { n: minutes }),
  })),
]);

const value = computed({
  get: () => (model.value === null ? BY_HAND : String(model.value)),
  set: (next: string) => {
    model.value = fetchIntervals.find((minutes) => String(minutes) === next) ?? null;
  },
});
</script>

<template>
  <div class="form-row grid items-start gap-x-3 gap-y-1 text-md text-fg-secondary">
    <label :for="id" class="flex h-6 items-center">{{ t("project.editDialog.fetch.label") }}</label>
    <Select
      :id="id"
      v-model="value"
      class="fetch-select"
      size="lg"
      :options="options"
      :described-by="hintId"
      data-testid="edit-project-fetch"
    />
    <p :id="hintId" class="col-start-2 text-sm text-fg-muted">
      {{ t("project.editDialog.fetch.hint") }}
    </p>
  </div>
</template>

<style scoped>
/* A form field's label takes 88px, 12px before its field, as the dialog's other rows. */
.form-row {
  grid-template-columns: 88px minmax(0, 1fr);
}
/* The interval's longest choice fits 200px; the field does not stretch to the dialog's width. */
.fetch-select {
  width: 200px;
}
</style>
