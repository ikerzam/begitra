<script setup lang="ts">
// The comparison's header: "Compare", the two endpoint controls, the swap control
// between them and "Open in terminal", in the order they are drawn so the tab order is the
// visual one.

import { ArrowLeftRight, Code, Terminal } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import type { CompareSide } from "@/stores/compare";
import type { CompareEndpoint } from "@/stores/settings";

import EndpointControl from "./EndpointControl.vue";

const props = defineProps<{
  a: CompareEndpoint;
  b: CompareEndpoint;
  /** Lane of each endpoint's branch, 0 when it has none. */
  lanes: Record<CompareSide, number>;
}>();
const emit = defineEmits<{
  pick: [side: CompareSide];
  swap: [];
  openTerminal: [];
  openEditor: [];
}>();

const { t } = useI18n();
</script>

<template>
  <header
    class="compare-header flex shrink-0 items-center gap-3 border-b border-line px-3"
    data-testid="compare-header"
  >
    <h2 class="text-md font-medium text-fg">{{ t("compare.title") }}</h2>
    <EndpointControl side="a" :endpoint="props.a" :lane="props.lanes.a" @pick="emit('pick', 'a')" />
    <IconButton
      :label="t('compare.swap')"
      :icon="ArrowLeftRight"
      data-testid="compare-swap"
      @click="emit('swap')"
    />
    <EndpointControl side="b" :endpoint="props.b" :lane="props.lanes.b" @pick="emit('pick', 'b')" />
    <span class="flex-1" />
    <Button
      variant="ghost"
      :icon="Terminal"
      data-testid="compare-terminal"
      @click="emit('openTerminal')"
    >
      {{ t("palette.commandsById.open-terminal") }}
    </Button>
    <Button variant="ghost" :icon="Code" data-testid="compare-editor" @click="emit('openEditor')">
      {{ t("palette.commandsById.open-editor") }}
    </Button>
  </header>
</template>

<style scoped>
/* 48px tall, unlike the 32px panel headers: the 28px controls and
   their focus ring need the room. Off the spacing scale. */
.compare-header {
  height: 48px;
}
</style>
