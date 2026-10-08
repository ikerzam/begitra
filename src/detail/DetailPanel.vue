<script setup lang="ts">
// The detail panel of graph focus: commit header, summary, stats line and the file tree.

import { Copy, FileDiff } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import DiffStat from "@/components/DiffStat.vue";
import EmptyState from "@/components/EmptyState.vue";
import { refocusAfterMenu } from "@/components/menuFocus";
import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import PanelHeader from "@/components/PanelHeader.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { FileChange } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { shortHash } from "@/shell/format";
import { useRepoStore } from "@/stores/repo";
import { useToastsStore } from "@/stores/toasts";

import CommitSummary from "./CommitSummary.vue";
import FileList, { type SelectTrigger } from "./FileList.vue";
import FileMenu from "./FileMenu.vue";
import { totals } from "./groupFiles";

const emit = defineEmits<{ review: [file?: FileChange] }>();

const { t } = useI18n();
const repo = useRepoStore();
const toasts = useToastsStore();

const commit = computed(() => repo.selectedCommit);
const detail = computed(() => repo.detail);
const stats = computed(() => (detail.value ? totals(detail.value.files) : null));

const detailError = computed(() => {
  const error = detail.value?.error;
  if (!error) return "";
  const text = errorText(error);
  return t(text.key, text.params);
});

async function copyHash(): Promise<void> {
  const hash = commit.value?.hash;
  if (!hash) return;
  try {
    await navigator.clipboard.writeText(hash);
  } catch {
    // Clipboard access can be denied; nothing else to do.
  }
}

function selectParent(hash: string): void {
  const index = repo.commits.findIndex((c) => c.hash === hash);
  if (index >= 0) repo.select(index);
  else toasts.push({ kind: "info", message: t("detail.parentNotLoaded") });
}

/* The keys move a selection through the tree; a click or Enter opens the file in review. */
const selectedPath = ref<string | null>(null);
/** The file whose menu is open, and where. */
const fileMenu = ref<{ file: FileChange; x: number; y: number } | null>(null);
const fileList = ref<{ focus(): void } | null>(null);

/** The file menu closed: the list takes the focus back unless an item moved it. */
function closeFileMenu(): void {
  fileMenu.value = null;
  refocusAfterMenu(() => fileList.value?.focus());
}
watch(
  () => detail.value?.hash,
  () => {
    selectedPath.value = null;
  },
);

function onSelect(file: FileChange, trigger: SelectTrigger): void {
  selectedPath.value = file.path;
  if (trigger === "pointer") emit("review", file);
}
</script>

<template>
  <aside class="flex min-w-0 flex-col border-l border-line" data-testid="detail-panel">
    <template v-if="repo.state.kind === 'ready' && commit">
      <PanelHeader :title="t('detail.commit')">
        <span class="truncate font-mono text-mono-sm text-fg-secondary" data-testid="detail-hash">
          {{ shortHash(commit.hash) }}
        </span>
        <template #actions>
          <IconButton :label="t('detail.copyHash')" :icon="Copy" @click="copyHash" />
          <IconButton :label="t('detail.review')" :icon="FileDiff" @click="emit('review')" />
        </template>
      </PanelHeader>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <CommitSummary :commit="commit" :refs="repo.refs" @select-parent="selectParent" />
        <div
          v-if="stats && detail"
          class="flex min-h-panel-header shrink-0 flex-wrap items-center gap-x-4 border-t border-b border-line px-3 text-md whitespace-nowrap"
          data-testid="detail-stats"
        >
          <span class="font-medium text-fg">
            {{
              stats.files === 1 ? t("detail.file", { n: 1 }) : t("detail.files", { n: stats.files })
            }}
          </span>
          <DiffStat :added="stats.additions" :removed="stats.deletions" />
          <span v-if="stats.generated > 0" class="text-fg-secondary">
            {{ t("detail.generated", { n: stats.generated }) }}
          </span>
          <span v-if="stats.tests > 0" class="text-fg-secondary">
            {{
              stats.tests === 1 ? t("detail.test", { n: 1 }) : t("detail.tests", { n: stats.tests })
            }}
          </span>
          <IconButton
            :label="t('detail.review')"
            :icon="FileDiff"
            class="ml-auto"
            data-testid="stats-review"
            @click="emit('review')"
          />
        </div>
        <template v-if="detail?.loading && detail.files.length === 0">
          <SkeletonRow v-for="n in 6" :key="n" :index="n" height="tree" />
        </template>
        <div v-if="detailError" class="p-3">
          <ErrorBanner :message="detailError" :output="detail?.error?.detail" />
        </div>
        <FileList
          v-if="detail"
          ref="fileList"
          :files="detail.files"
          :selected-path="selectedPath"
          @select="onSelect"
          @activate="(file) => emit('review', file)"
          @menu="(file, x, y) => (fileMenu = { file, x, y })"
        />
        <FileMenu
          v-if="fileMenu"
          :file="fileMenu.file"
          :x="fileMenu.x"
          :y="fileMenu.y"
          :source="{ kind: 'commit', hash: commit.hash }"
          review
          @review="(file) => emit('review', file)"
          @close="closeFileMenu"
        />
      </div>
    </template>
    <EmptyState
      v-else-if="repo.state.kind === 'ready' || repo.state.kind === 'opening'"
      class="flex-1"
      :message="t('detail.selectCommit')"
    />
    <EmptyState v-else class="flex-1" :message="t('detail.nothingUntilOpen')" />
  </aside>
</template>
