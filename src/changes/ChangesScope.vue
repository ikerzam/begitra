<script setup lang="ts">
// Gives the changes screen's components in its slot the model of one repository (the folder
// view's sections, box and viewer). Keyed by the repository where it is used, so its
// components start again when the repository changes.

import { provideChanges, type ChangesView } from "./useChanges";

const props = defineProps<{ view: ChangesView }>();

provideChanges(props.view);
</script>

<template>
  <slot />
</template>
