<script setup lang="ts">
// The menu of a diff line: Copy while text is selected, "Open in editor at line N" (the new
// side's line; absent for a deleted file) and Copy path. It opens on a right click of a line or
// its numbers, and on the menu key while the diff has focus.

import { Code, Copy, FileText } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import { copyText } from "@/shell/clipboard";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useToastsStore } from "@/stores/toasts";

const props = defineProps<{
  x: number;
  y: number;
  /** The file's repository-relative path. */
  path: string;
  /** The new side's line, or null when there is none to open. */
  line: number | null;
  /** The text selected where the menu opened, if any. */
  selection: string;
}>();
const emit = defineEmits<{ close: []; open: [line: number] }>();

const { t } = useI18n();
const toasts = useToastsStore();
const copyHint = formatShortcut("mod+c", shortcutRegistry().platform);

async function copyPath(): Promise<void> {
  if (await copyText(props.path)) {
    toasts.push({ kind: "success", message: t("fileMenu.pathCopied", { path: props.path }) });
  } else {
    toasts.push({ kind: "error", message: t("graph.clipboardUnavailable") });
  }
}
</script>

<template>
  <Teleport to="body">
    <ContextMenu
      :x="props.x"
      :y="props.y"
      :label="t('lineMenu.label')"
      data-testid="line-menu"
      @close="emit('close')"
    >
      <template v-if="props.selection !== ''">
        <ContextMenuItem
          :label="t('textMenu.copy')"
          :icon="Copy"
          :keys="copyHint"
          data-testid="line-menu-copy"
          @select="() => void copyText(props.selection)"
        />
        <ContextMenuSeparator />
      </template>
      <ContextMenuItem
        v-if="props.line !== null"
        :label="t('lineMenu.openAtLine', { line: props.line })"
        :icon="Code"
        data-testid="line-menu-editor"
        @select="() => props.line !== null && emit('open', props.line)"
      />
      <ContextMenuItem
        :label="t('fileMenu.copyPath')"
        :icon="FileText"
        data-testid="line-menu-copy-path"
        @select="() => void copyPath()"
      />
    </ContextMenu>
  </Teleport>
</template>
