<script setup lang="ts">
// The confirmation of "Remove from project" for a member of the open project that belongs to
// no other project: it leaves Begitra, so the dialog names it first and says its
// folder stays. `projects.askRemoveMember` asks for it; the other removals need no question.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import { sameFolder } from "@/shell/format";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";

import LeavingList from "./LeavingList.vue";

const props = defineProps<{ path: string }>();

const { t } = useI18n();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();

const member = computed(() =>
  projects.activeMembers.find((known) => sameFolder(known.path, props.path)),
);

async function remove(): Promise<void> {
  dialogs.close();
  await projects.removeMember(props.path);
}
</script>

<template>
  <Dialog
    v-if="projects.active && member"
    variant="destructive"
    :title="t('project.removeDialog.title', { name: member.name, project: projects.active.name })"
    :body="t('project.removeDialog.body')"
    :confirm-label="t('project.removeFromProject')"
    data-testid="remove-member-dialog"
    @confirm="() => void remove()"
    @cancel="dialogs.close()"
  >
    <LeavingList :members="[member]" />
  </Dialog>
</template>
