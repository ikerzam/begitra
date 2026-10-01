<script setup lang="ts">
// The comparison's header: "Compare", the two endpoint controls, the swap control between
// them, and the action group's two icons, "Open in terminal" and "Open in editor" with their
// shortcuts, in the order they show so the tab order is the visual one.

import { ArrowLeftRight, Code, Terminal } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import { useShortcutHint } from "@/shortcuts/useShortcut";
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
const terminalKeys = useShortcutHint("open-terminal");
const editorKeys = useShortcutHint("open-editor");
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
    <!-- The action group: 24px buttons on a 32px pitch, as the panel headers' icons. -->
    <span class="flex items-center gap-2">
      <IconButton
        :label="t('palette.commandsById.open-terminal')"
        :icon="Terminal"
        :keys="terminalKeys"
        data-testid="compare-terminal"
        @click="emit('openTerminal')"
      />
      <IconButton
        :label="t('palette.commandsById.open-editor')"
        :icon="Code"
        :keys="editorKeys"
        data-testid="compare-editor"
        @click="emit('openEditor')"
      />
    </span>
  </header>
</template>

<style scoped>
/* 48px tall, unlike the 32px panel headers: the 28px controls and their focus ring need the
   room. Off the spacing scale. */
.compare-header {
  height: 48px;
}
</style>
