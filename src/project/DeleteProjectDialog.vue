<script setup lang="ts">
// The confirmation of a project's deletion: it names the project and, first, the
// repositories and worktrees no other project holds, which leave Begitra with it; their folders
// stay, and opening one or a scan brings it back. Deleting writes to no repository.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";

import LeavingList from "./LeavingList.vue";

const props = defineProps<{ id: number }>();

const { t, n } = useI18n();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();

const project = computed(() => projects.find(props.id) ?? null);
/** The members no other project holds: they leave the index with the project. */
const leaving = computed(() => {
  const current = project.value;
  if (!current) return [];
  return projects
    .members(current)
    .filter((member) => projects.leaving(current, [member.path]).length > 0);
});
const body = computed(() => {
  const count = leaving.value.length;
  return count === 0
    ? t("project.deleteDialog.bodyKept")
    : t("project.deleteDialog.bodyLeaving", { n: n(count) }, count);
});

async function confirm(): Promise<void> {
  const current = project.value;
  dialogs.close();
  if (current) await projects.remove(current.id);
}
</script>

<template>
  <Dialog
    v-if="project"
    variant="destructive"
    :title="t('project.deleteDialog.title', { name: project.name })"
    :body="body"
    :confirm-label="t('project.deleteDialog.confirm')"
    data-testid="delete-project-dialog"
    @confirm="() => void confirm()"
    @cancel="dialogs.close()"
  >
    <LeavingList v-if="leaving.length > 0" :members="leaving" />
  </Dialog>
</template>
