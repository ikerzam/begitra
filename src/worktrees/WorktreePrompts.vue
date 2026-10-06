<script setup lang="ts">
// The one confirmation of each worktree write, through `Dialog`: remove (the folder goes,
// the branch stays unless "Delete the branch too" is ticked), remove anyway (git refused a
// dirty worktree: the changes will be lost; the tick kept), prune (the entries whose folders
// are missing) and lock (with an optional reason).

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import Dialog from "@/components/Dialog.vue";
import Input from "@/components/Input.vue";
import { baseName } from "@/shell/format";
import { useWorktreesStore, type WorktreePrompt } from "@/stores/worktrees";

const props = defineProps<{ prompt: WorktreePrompt }>();

const { t } = useI18n();
const worktrees = useWorktreesStore();
const reason = ref("");
/** "Delete the branch too", as the prompt asked it (kept from the first confirmation). */
const deleteBranch = ref(props.prompt.kind === "remove" && Boolean(props.prompt.branch));

/** The path the prompt concerns; none for prune. */
const path = computed(() => {
  const prompt = props.prompt;
  return prompt.kind === "prune" ? null : prompt.path;
});
const row = computed(() => worktrees.rows.find((entry) => entry.path === path.value) ?? null);
const folder = computed(() => (path.value === null ? "" : baseName(path.value)));
/** The branch the worktree holds; null when detached, and on an orphan branch with no commit yet,
 * which has no ref to delete or keep. */
const branchName = computed(() => (row.value?.head ? (row.value.branch ?? null) : null));

const title = computed(() => {
  switch (props.prompt.kind) {
    case "remove":
      return props.prompt.force
        ? t("worktrees.removeAnyway.title", { folder: folder.value })
        : t("worktrees.remove.title", { folder: folder.value });
    case "prune":
      return t("worktrees.prune.title");
    case "lock":
      return t("worktrees.lockPrompt.title", { folder: folder.value });
  }
});
const body = computed(() => {
  switch (props.prompt.kind) {
    case "remove": {
      const branch = branchName.value;
      // A detached worktree holds no branch: nothing stays or goes with it.
      const which = branch === null ? "Detached" : deleteBranch.value ? "WithBranch" : "";
      const key = props.prompt.force ? "worktrees.removeAnyway.body" : "worktrees.remove.body";
      return t(`${key}${which}`, { path: props.prompt.path, branch: branch ?? "" });
    }
    case "prune":
      return t("worktrees.prune.body", {
        paths: props.prompt.paths.join(", "),
        n: props.prompt.paths.length,
      });
    case "lock":
      return t("worktrees.lockPrompt.body");
  }
});
const confirmLabel = computed(() => {
  switch (props.prompt.kind) {
    case "remove":
      // "Remove anyway" names the force whatever goes with it; the body says the branch does.
      if (props.prompt.force) return t("worktrees.removeAnyway.confirm");
      return deleteBranch.value && branchName.value !== null
        ? t("worktrees.remove.confirmWithBranch")
        : t("worktrees.remove.confirm");
    case "prune":
      return t("worktrees.prune.confirm");
    case "lock":
      return t("worktrees.lockPrompt.confirm");
  }
});
const destructive = computed(() => props.prompt.kind !== "lock");

function confirm(): void {
  const prompt = props.prompt;
  switch (prompt.kind) {
    case "remove":
      void worktrees.remove(
        prompt.path,
        prompt.force,
        deleteBranch.value ? branchName.value : null,
      );
      break;
    case "prune":
      void worktrees.prune();
      break;
    case "lock":
      void worktrees.lock(prompt.path, reason.value.trim() || null);
      break;
  }
}
</script>

<template>
  <Dialog
    :title="title"
    :body="body"
    :confirm-label="confirmLabel"
    :variant="destructive ? 'destructive' : 'default'"
    :data-testid="`worktree-prompt-${props.prompt.kind}`"
    @confirm="confirm"
    @cancel="worktrees.dismissPrompt()"
  >
    <Checkbox
      v-if="props.prompt.kind === 'remove' && branchName !== null"
      v-model="deleteBranch"
      :label="t('worktrees.remove.deleteBranch', { branch: branchName })"
      data-testid="remove-delete-branch"
    />
    <Input
      v-if="props.prompt.kind === 'lock'"
      v-model="reason"
      :placeholder="t('worktrees.lockPrompt.reasonPlaceholder')"
      :aria-label="t('worktrees.lockPrompt.reason')"
      data-autofocus
      data-testid="lock-reason"
    />
  </Dialog>
</template>
