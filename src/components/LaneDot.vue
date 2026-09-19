<script setup lang="ts">
import { laneBgClass, laneIndex } from "./lanes";

const props = withDefaults(
  defineProps<{
    /** Graph lane of the branch, from 1; cycles every eight. */
    lane?: number;
  }>(),
  { lane: 1 },
);
</script>

<template>
  <span
    aria-hidden="true"
    class="inline-block size-2 shrink-0 rounded-full"
    :class="laneBgClass(props.lane)"
    :data-lane="laneIndex(props.lane)"
  />
</template>
