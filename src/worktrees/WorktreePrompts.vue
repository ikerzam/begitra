<script setup lang="ts">
// The one confirmation of each worktree write, through `Dialog`: remove (the folder goes,
// the branch stays), remove anyway (git refused a dirty worktree: the changes will be lost),
// prune (the entries whose folders are missing) and lock (with an optional reason).

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import Input from "@/components/Input.vue";
import { baseName } from "@/shell/format";
import { useWorktreesStore, type WorktreePrompt } from "@/stores/worktrees";

const props = defineProps<{ prompt: WorktreePrompt }>();

const { t } = useI18n();
const worktrees = useWorktreesStore();
const reason = ref("");

/** The path the prompt concerns; none for prune. */
const path = computed(() => {
  const prompt = props.prompt;
  return prompt.kind === "prune" ? null : prompt.path;
});
const row = computed(() => worktrees.rows.find((entry) => entry.path === path.value) ?? null);
const folder = computed(() => (path.value === null ? "" : baseName(path.value)));

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
      const branch = row.value?.branch ?? "";
      return props.prompt.force
        ? t("worktrees.removeAnyway.body", { branch })
        : t("worktrees.remove.body", { path: props.prompt.path, branch });
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
      return props.prompt.force
        ? t("worktrees.removeAnyway.confirm")
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
      void worktrees.remove(prompt.path, prompt.force);
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
