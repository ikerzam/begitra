<script setup lang="ts">
// The menu of a diff line, the copies first as in every file menu: Copy while text is selected,
// Copy path and Copy link; then the opens: "Open in editor at line N" (the new side's line;
// absent for a deleted file), Open on <forge> (a commit's file at the line) and File history
// (absent for a file new in a change not committed yet). It opens on a right click of a line or
// its numbers, and on the menu key while the diff has focus.

import { Code, Copy, FileText, History } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import CopyLinkItem from "@/remotes/CopyLinkItem.vue";
import OpenLinkItem from "@/remotes/OpenLinkItem.vue";
import type { Link } from "@/remotes/useLinks";
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
  /** Whether the file has a history for the graph to list. */
  history: boolean;
  /** The file's page on its forge, at the line for a commit's file; null when it has none. */
  link: Link | null;
}>();
const emit = defineEmits<{ close: []; open: [line: number]; history: [] }>();

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
      <ContextMenuItem
        v-if="props.selection !== ''"
        :label="t('textMenu.copy')"
        :icon="Copy"
        :keys="copyHint"
        data-testid="line-menu-copy"
        @select="() => void copyText(props.selection)"
      />
      <ContextMenuItem
        :label="t('fileMenu.copyPath')"
        :icon="FileText"
        data-testid="line-menu-copy-path"
        @select="() => void copyPath()"
      />
      <CopyLinkItem v-if="props.link" :link="props.link" />
      <template v-if="props.line !== null || props.link || props.history">
        <ContextMenuSeparator />
        <ContextMenuItem
          v-if="props.line !== null"
          :label="t('lineMenu.openAtLine', { line: props.line })"
          :icon="Code"
          data-testid="line-menu-editor"
          @select="() => props.line !== null && emit('open', props.line)"
        />
        <OpenLinkItem v-if="props.link" :link="props.link" />
        <ContextMenuItem
          v-if="props.history"
          :label="t('fileMenu.history')"
          :icon="History"
          data-testid="line-menu-history"
          @select="emit('history')"
        />
      </template>
    </ContextMenu>
  </Teleport>
</template>
