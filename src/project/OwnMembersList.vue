<script setup lang="ts">
// A folder project's own repositories in "Edit project…": the folder they are found in, the
// repositories its scans keep (one missing flagged), which no edit moves or removes, and how
// the scans keep them.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import type { Project } from "@/ipc/schemas";
import { useIndexStore } from "@/stores/index";
import { resolveMembers } from "@/stores/projects";

const props = defineProps<{ project: Project & { folder: string } }>();

const { t } = useI18n();
const index = useIndexStore();
const format = useDiscoveryFormat();

const own = computed(() =>
  resolveMembers(
    {
      folder: props.project.folder,
      members: props.project.members.filter((member) => member.origin === "folder"),
    },
    index.entries,
    index.read,
    false,
  ),
);
</script>

<template>
  <div class="flex items-center gap-2 text-md">
    <span class="text-fg-secondary">{{ t("project.editDialog.found") }}</span>
    <span class="truncate font-mono text-mono-sm text-fg-muted">
      {{ format.displayPath(props.project.folder) }}
    </span>
  </div>
  <ul
    class="own flex flex-col overflow-y-auto rounded-md border border-line"
    :aria-label="t('project.editDialog.found')"
    data-testid="edit-project-own"
  >
    <li
      v-for="member in own"
      :key="member.path"
      class="flex h-panel-header shrink-0 items-center gap-2 border-b border-line px-3 text-md last:border-b-0"
    >
      <span class="truncate" :class="member.missing ? 'text-fg-muted' : 'text-fg'">
        {{ member.name }}
      </span>
      <span v-if="member.missing" class="text-sm text-warn">
        {{ t("project.editDialog.missing") }}
      </span>
    </li>
    <li v-if="own.length === 0" class="px-3 py-2 text-sm text-fg-muted">
      {{ t("project.editDialog.noneFound") }}
    </li>
  </ul>
  <p class="text-sm text-fg-muted">{{ t("project.editDialog.foundHint") }}</p>
</template>

<style scoped>
/* Six rows, then the folder's own list scrolls, so Save stays in the window. */
.own {
  max-height: 194px;
}
</style>
