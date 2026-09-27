<script setup lang="ts">
// The repository switcher of the top bar: the current name, and a menu (overlay treatment,
// under the button) with the active project's members while the open repository is one of
// them, the pinned repositories, the five most recent, "Go to repositories" and "Open
// folder…". The current repository is marked; ↑↓ move, ↵ picks, esc closes.

import { Check, ChevronDown, FolderGit2, FolderOpen, LayoutGrid, ListTree } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import type { IndexEntry } from "@/ipc/schemas";
import { useIndexStore } from "@/stores/index";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";

const props = defineProps<{
  /** Name of the open repository, or null when none is open. */
  repositoryName: string | null;
  /** Root of the open repository, to mark it in the menu. */
  repositoryRoot: string | null;
}>();
const emit = defineEmits<{ openFolder: [] }>();

const { t } = useI18n();
const index = useIndexStore();
const projects = useProjectsStore();
const repo = useRepoStore();
const format = useDiscoveryFormat();

const open = ref(false);
const button = ref<HTMLElement | null>(null);

const label = computed(() => props.repositoryName ?? t("topBar.noRepository"));
/** The active project's members that are there, while the open repository is one of them. */
const members = computed(() =>
  projects.openIsMember
    ? projects.activeMembers.flatMap((member) =>
        member.entry && !member.missing ? [member.entry] : [],
      )
    : [],
);
const hasEntries = computed(
  () => members.value.length > 0 || index.pinned.length > 0 || index.recent.length > 0,
);

function toggle(): void {
  open.value = !open.value;
}

function close(): void {
  open.value = false;
  void nextTick(() => button.value?.focus());
}

function onButtonKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" && !open.value) {
    event.preventDefault();
    open.value = true;
  }
}

function icon(entry: IndexEntry) {
  if (entry.path === props.repositoryRoot) return Check;
  return entry.kind === "worktree" ? ListTree : FolderGit2;
}

function choose(entry: IndexEntry): void {
  void index.open(entry.path);
}

function goToRepositories(): void {
  void repo.close();
}
</script>

<template>
  <div class="relative flex min-w-0 items-center">
    <button
      ref="button"
      type="button"
      class="flex h-control min-w-0 items-center gap-2 rounded-md px-2 text-md font-medium text-fg hover:bg-hover"
      :data-tooltip="t('switcher.label')"
      :aria-description="t('switcher.label')"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-testid="repo-switcher"
      @click="toggle"
      @keydown="onButtonKeydown"
    >
      <FolderGit2 :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
      <span class="truncate">{{ label }}</span>
      <ChevronDown :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
    </button>
    <ContextMenu
      v-if="open"
      class="switcher-menu absolute top-full left-0 z-40 mt-1"
      :label="t('switcher.label')"
      :anchor="button"
      data-testid="repo-switcher-menu"
      @close="close"
    >
      <template v-if="members.length > 0">
        <p class="px-2 pt-1 pb-1 text-sm text-fg-muted" data-testid="switcher-project">
          {{ projects.active?.name }}
        </p>
        <ContextMenuItem
          v-for="entry in members"
          :key="`project:${entry.path}`"
          :label="entry.name"
          :icon="icon(entry)"
          :context="format.displayPath(entry.path)"
          :aria-current="entry.path === props.repositoryRoot ? 'true' : undefined"
          :data-path="entry.path"
          @select="choose(entry)"
        />
      </template>
      <template v-if="index.pinned.length > 0">
        <p class="px-2 pt-1 pb-1 text-sm text-fg-muted">{{ t("switcher.pinned") }}</p>
        <ContextMenuItem
          v-for="entry in index.pinned"
          :key="entry.path"
          :label="entry.name"
          :icon="icon(entry)"
          :context="format.displayPath(entry.path)"
          :aria-current="entry.path === props.repositoryRoot ? 'true' : undefined"
          :data-path="entry.path"
          @select="choose(entry)"
        />
      </template>
      <template v-if="index.recent.length > 0">
        <p class="px-2 pt-1 pb-1 text-sm text-fg-muted">{{ t("switcher.recent") }}</p>
        <ContextMenuItem
          v-for="entry in index.recent"
          :key="entry.path"
          :label="entry.name"
          :icon="icon(entry)"
          :context="format.displayPath(entry.path)"
          :aria-current="entry.path === props.repositoryRoot ? 'true' : undefined"
          :data-path="entry.path"
          @select="choose(entry)"
        />
      </template>
      <ContextMenuSeparator v-if="hasEntries" />
      <ContextMenuItem
        :label="t('switcher.goToRepositories')"
        :icon="LayoutGrid"
        :disabled="repo.state.kind === 'empty'"
        data-testid="switcher-home"
        @select="goToRepositories"
      />
      <ContextMenuItem
        :label="t('home.openFolder')"
        :icon="FolderOpen"
        data-testid="switcher-open-folder"
        @select="emit('openFolder')"
      />
    </ContextMenu>
  </div>
</template>

<style scoped>
/* Wide enough for a name and its path (menus are at least 220px; 360 fits "~/code/…"),
   and scrolling inside the window under the top bar when many repositories are pinned. */
.switcher-menu {
  width: 360px;
  max-height: calc(100vh - 64px);
  overflow-y: auto;
}
</style>
