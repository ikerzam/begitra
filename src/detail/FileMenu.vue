<script setup lang="ts">
// The menu of a file row (the commit's files, the review's and the comparison's files panel):
// Open in review where the panel offers it, Copy path (the repository-relative path, with a
// toast) and Open in editor (the file on disk; nothing to open for a deleted file).

import { Code, Copy, FileDiff } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import type { FileChange } from "@/ipc/schemas";
import { copyText } from "@/shell/clipboard";
import { useExternal } from "@/shell/useExternal";
import { useRepoStore } from "@/stores/repo";
import { useToastsStore } from "@/stores/toasts";

const props = withDefaults(
  defineProps<{
    file: FileChange;
    x: number;
    y: number;
    /** Whether "Open in review" is offered (not in the review itself). */
    review?: boolean;
  }>(),
  { review: false },
);
const emit = defineEmits<{ close: []; review: [file: FileChange] }>();

const { t } = useI18n();
const repo = useRepoStore();
const toasts = useToastsStore();
const external = useExternal();

const deleted = computed(() => props.file.status === "deleted");

async function copyPath(): Promise<void> {
  if (await copyText(props.file.path)) {
    toasts.push({ kind: "success", message: t("fileMenu.pathCopied", { path: props.file.path }) });
  } else {
    toasts.push({ kind: "error", message: t("graph.clipboardUnavailable") });
  }
}

/** The file on disk: the repository's root and the path, which the editor takes either way. */
function openInEditor(): void {
  const root = repo.repo?.root;
  if (!root) return;
  const separator = root.includes("\\") ? "\\" : "/";
  const relative = separator === "\\" ? props.file.path.replaceAll("/", "\\") : props.file.path;
  void external.openEditor(`${root.replace(/[\\/]+$/, "")}${separator}${relative}`);
}
</script>

<template>
  <ContextMenu
    :x="props.x"
    :y="props.y"
    :label="t('fileMenu.label')"
    data-testid="file-menu"
    @close="emit('close')"
  >
    <template v-if="props.review">
      <ContextMenuItem
        :label="t('fileMenu.openInReview')"
        :icon="FileDiff"
        data-testid="file-menu-review"
        @select="emit('review', props.file)"
      />
      <ContextMenuSeparator />
    </template>
    <ContextMenuItem
      :label="t('fileMenu.copyPath')"
      :icon="Copy"
      data-testid="file-menu-copy"
      @select="() => void copyPath()"
    />
    <ContextMenuItem
      :label="t('fileMenu.openInEditor')"
      :icon="Code"
      :disabled="deleted"
      data-testid="file-menu-editor"
      @select="openInEditor"
    />
  </ContextMenu>
</template>
