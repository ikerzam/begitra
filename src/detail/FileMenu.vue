<script setup lang="ts">
// The menu of a file row (the commit's files, the review's and the comparison's files panel):
// Open in review where the panel offers it, Copy path (the repository-relative path, with a
// toast), Copy link and Open on <forge> (the file at its commit, or a working file at the
// upstream), Reveal in Explorer (a working file on disk), Open in editor (the file on disk;
// nothing to open for a deleted file) and File history (the graph filtered by the path the
// commits have; none for a file new in the working tree or the index).

import { Code, Copy, FileDiff, History } from "@lucide/vue";
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";

import { useStagedFiles } from "@/changes/useChanges";
import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import { historyPath, type HistorySide } from "@/graph/fileHistory";
import type { FileChange } from "@/ipc/schemas";
import CopyLinkItem from "@/remotes/CopyLinkItem.vue";
import { revealTarget, type FileSource } from "@/remotes/fileLinks";
import OpenLinkItem from "@/remotes/OpenLinkItem.vue";
import RevealItem from "@/remotes/RevealItem.vue";
import { useLinks } from "@/remotes/useLinks";
import { copyText } from "@/shell/clipboard";
import { useExternal } from "@/shell/useExternal";
import { useGraphStore } from "@/stores/graph";
import { useRepoStore } from "@/stores/repo";
import { useToastsStore } from "@/stores/toasts";

const props = withDefaults(
  defineProps<{
    file: FileChange;
    x: number;
    y: number;
    /** Whether "Open in review" is offered (not in the review itself). */
    review?: boolean;
    /** Where the file's change stands: a commit's, or the review's of the index or working tree. */
    side?: HistorySide;
    /** Where the file is, for its link and Reveal; none offers neither. */
    source?: FileSource | null;
  }>(),
  { review: false, side: "committed", source: null },
);
const emit = defineEmits<{ close: []; review: [file: FileChange] }>();

const { t } = useI18n();
const repo = useRepoStore();
const graph = useGraphStore();
const toasts = useToastsStore();
const external = useExternal();
const staged = useStagedFiles();

const deleted = computed(() => props.file.status === "deleted");
const history = computed(() => historyPath(props.file, props.side, staged));
const links = useLinks();
const link = computed(() => links.fileLink(props.file, props.source));
const revealed = computed(() => revealTarget(props.file, props.source));
onMounted(links.ensureRemotes);

async function copyPath(): Promise<void> {
  if (await copyText(props.file.path)) {
    toasts.push({ kind: "success", message: t("fileMenu.pathCopied", { path: props.file.path }) });
  } else {
    toasts.push({ kind: "error", message: t("graph.clipboardUnavailable") });
  }
}

/** The file of the open repository's working tree. */
function openInEditor(): void {
  const root = repo.repo?.root;
  if (root) void external.openFile(root, props.file.path);
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
    <CopyLinkItem v-if="link" :link="link" />
    <ContextMenuSeparator />
    <OpenLinkItem v-if="link" :link="link" />
    <RevealItem
      v-if="revealed"
      :root="revealed.root"
      :path="revealed.path"
      :shown="props.file.path"
    />
    <ContextMenuItem
      :label="t('fileMenu.openInEditor')"
      :icon="Code"
      :disabled="deleted"
      data-testid="file-menu-editor"
      @select="openInEditor"
    />
    <ContextMenuItem
      v-if="history !== null"
      :label="t('fileMenu.history')"
      :icon="History"
      data-testid="file-menu-history"
      @select="() => history !== null && void graph.showHistory(history)"
    />
  </ContextMenu>
</template>
