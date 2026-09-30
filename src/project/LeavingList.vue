<script setup lang="ts">
// The repositories and worktrees an edit or a deletion takes out of Begitra: each
// with its name and its path in mono, bordered as the dialogs' lists are; six rows, then the
// list scrolls.

import { FolderGit2, ListTree } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import type { ProjectMember } from "@/stores/projects";

const props = defineProps<{ members: ProjectMember[] }>();

const { t } = useI18n();
const format = useDiscoveryFormat();
</script>

<template>
  <ul
    class="leaving flex flex-col overflow-y-auto rounded-md border border-line px-3 py-1"
    :aria-label="t('project.leaving.label')"
    data-testid="leaving-list"
  >
    <li
      v-for="member in props.members"
      :key="member.path"
      class="flex h-control shrink-0 items-center gap-2 text-md"
      data-testid="leaving-member"
    >
      <component
        :is="member.entry?.kind === 'worktree' ? ListTree : FolderGit2"
        :size="16"
        :stroke-width="1.5"
        class="shrink-0 text-fg-secondary"
        aria-hidden="true"
      />
      <span class="shrink-0 text-fg">{{ member.name }}</span>
      <span class="truncate font-mono text-mono-sm text-fg-muted">
        {{ format.displayPath(member.path) }}
      </span>
    </li>
  </ul>
</template>

<style scoped>
/* Six rows of 28px and the list's padding, then it scrolls. */
.leaving {
  max-height: 178px;
}
</style>
