<script setup lang="ts">
// The confirmation of an undo of a commit a remote holds already: the commit stays there, the
// next push needs a forced push, Revert undoes it without one, and the reflog keeps it. It is
// busy while the confirmation plans the undo again, so a second press neither asks nor runs.

import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import { useBranchesStore } from "@/stores/branches";

const { t } = useI18n();
const branches = useBranchesStore();

function confirm(): void {
  const prompt = branches.prompt;
  if (prompt?.kind === "undoCommit") void branches.undoLastCommit({ confirmed: prompt.hash });
}
</script>

<template>
  <Dialog
    v-if="branches.prompt?.kind === 'undoCommit'"
    :title="t('branches.dialogs.undoCommitTitle', { hash: branches.prompt.label })"
    :body="
      t('branches.dialogs.undoCommitBody', {
        hash: branches.prompt.label,
        remote: branches.prompt.remote,
      })
    "
    :confirm-label="t('branches.undoCommit')"
    :busy="branches.planningUndo"
    data-testid="undo-commit-dialog"
    @confirm="confirm"
    @cancel="branches.dismiss()"
  />
</template>
