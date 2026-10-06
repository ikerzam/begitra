<script setup lang="ts">
// A checkout of a branch another worktree holds: git checks a branch out in one worktree at a
// time, so the dialog names that worktree's folder and offers to open it as the context.

import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import { baseName } from "@/shell/format";
import { useBranchesStore } from "@/stores/branches";
import { useWorktreesStore } from "@/stores/worktrees";

const { t } = useI18n();
const branches = useBranchesStore();
const worktrees = useWorktreesStore();

function open(): void {
  const prompt = branches.prompt;
  if (prompt?.kind !== "heldElsewhere") return;
  branches.dismiss();
  void worktrees.openAsContext(prompt.path);
}
</script>

<template>
  <Dialog
    v-if="branches.prompt?.kind === 'heldElsewhere'"
    :title="t('branches.dialogs.heldTitle', { branch: branches.prompt.branch })"
    :body="
      t('branches.dialogs.heldBody', {
        branch: branches.prompt.branch,
        folder: baseName(branches.prompt.path),
      })
    "
    :confirm-label="t('branches.openWorktree')"
    data-testid="held-worktree-dialog"
    @confirm="open"
    @cancel="branches.dismiss()"
  >
    <p
      class="font-mono text-mono-sm break-all text-fg-secondary select-text"
      data-testid="held-worktree-path"
    >
      {{ branches.prompt.path }}
    </p>
  </Dialog>
</template>
