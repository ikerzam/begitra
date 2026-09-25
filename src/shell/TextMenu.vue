<script setup lang="ts">
// The app's menu on selected text outside the text fields (useNativeMenu): Copy, which the
// webview's own menu would have offered among "Save as" and "Print".

import { Copy } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";

import { copyText } from "./clipboard";

const props = defineProps<{ x: number; y: number; text: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const copyHint = formatShortcut("mod+c", shortcutRegistry().platform);
</script>

<template>
  <ContextMenu
    :x="props.x"
    :y="props.y"
    :label="t('textMenu.label')"
    data-testid="text-menu"
    @close="emit('close')"
  >
    <ContextMenuItem
      :label="t('textMenu.copy')"
      :icon="Copy"
      :keys="copyHint"
      data-testid="text-menu-copy"
      @select="() => void copyText(props.text)"
    />
  </ContextMenu>
</template>
