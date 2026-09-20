<script setup lang="ts">
// One row of a settings section: the label in a 180px column, the
// control in a 420px one, the hint under the control.

const props = withDefaults(
  defineProps<{
    label: string;
    /** The id of the control the label points at; none for a group of controls. */
    for?: string;
    hint?: string;
    /** The hint in `--danger` (the git path that does not run). */
    danger?: boolean;
    /** The id of the hint, for a control's `aria-describedby`. */
    hintId?: string;
    /** The control spans the column instead of stopping at 420px (lists, the git row). */
    wide?: boolean;
  }>(),
  { for: undefined, hint: "", danger: false, hintId: undefined, wide: false },
);
</script>

<template>
  <div
    class="settings-field grid items-start gap-x-4 gap-y-1"
    :class="{ 'settings-field-wide': props.wide }"
    data-testid="settings-field"
  >
    <component
      :is="props.for ? 'label' : 'span'"
      :for="props.for"
      class="text-md text-fg-secondary"
    >
      {{ props.label }}
    </component>
    <div class="settings-control min-w-0">
      <slot />
    </div>
    <p
      v-if="props.hint || $slots.hint"
      :id="props.hintId"
      class="settings-hint col-start-2 text-sm"
      :class="props.danger ? 'text-danger' : 'text-fg-muted'"
      data-testid="settings-hint"
    >
      <slot name="hint">{{ props.hint }}</slot>
    </p>
  </div>
</template>

<style scoped>
/* 180px labels and 420px controls, the label's line box top-aligned
   with the control; off the spacing scale. */
.settings-field {
  grid-template-columns: 180px minmax(0, 420px);
}
.settings-field-wide {
  grid-template-columns: 180px minmax(0, 1fr);
}
</style>
