<script setup lang="ts">
// The add-worktree dialog: Branch (a new branch with its name, or a local branch no worktree
// has checked out), Start from (a new branch only; the current branch by default), Path
// (the worktree folder plus the branch name, slashes as dashes; editable; refused when the
// folder exists) and, when git refuses, its output inline while the dialog stays open. The
// state and the rules live in `useAddWorktreeForm`.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import Input from "@/components/Input.vue";
import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import { errorText } from "@/shell/errorMessage";
import { useWorktreesStore } from "@/stores/worktrees";

import { NEW_BRANCH, useAddWorktreeForm } from "./useAddWorktreeForm";

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const worktrees = useWorktreesStore();
const form = useAddWorktreeForm();

const branchOptions = computed<SelectOption[]>(() => [
  { value: NEW_BRANCH, label: t("worktrees.add.newBranch") },
  ...form.freeBranches.value.map((name) => ({ value: name, label: name })),
]);
const startOptions = computed<SelectOption[]>(() =>
  form.localBranches.value.map((name) => ({ value: name, label: name })),
);
const nameError = computed(() => (form.nameInvalid.value ? t("worktrees.add.invalidName") : ""));
const pathError = computed(() => (form.pathExists.value ? t("worktrees.add.folderExists") : ""));
const failure = computed(() => {
  const error = worktrees.error;
  if (!error) return null;
  const text = errorText(error);
  return { message: t(text.key, text.params), output: error.detail ?? "" };
});

async function submit(): Promise<void> {
  if (await form.submit()) emit("close");
}
</script>

<template>
  <Dialog
    :title="t('worktrees.add.title')"
    :body="t('worktrees.add.body')"
    :confirm-label="form.submitting.value ? t('worktrees.add.adding') : t('worktrees.add.confirm')"
    :confirm-disabled="!form.canSubmit.value"
    :busy="form.submitting.value"
    @confirm="() => void submit()"
    @cancel="emit('close')"
  >
    <form
      class="add-worktree-grid grid items-center gap-3"
      data-testid="add-worktree-form"
      @submit.prevent="() => void submit()"
    >
      <label for="add-worktree-branch" class="text-md text-fg-secondary">
        {{ t("worktrees.add.branch") }}
      </label>
      <div class="flex items-center gap-3">
        <Select
          id="add-worktree-branch"
          v-model="form.branch.value"
          class="branch-select shrink-0"
          :options="branchOptions"
          data-testid="add-worktree-branch"
        />
        <Input
          v-if="form.isNew.value"
          v-model="form.name.value"
          :placeholder="t('worktrees.add.namePlaceholder')"
          :error="nameError"
          data-autofocus
          data-testid="add-worktree-name"
        />
      </div>
      <template v-if="form.isNew.value">
        <label for="add-worktree-start" class="text-md text-fg-secondary">
          {{ t("worktrees.add.startFrom") }}
        </label>
        <Select
          id="add-worktree-start"
          v-model="form.start.value"
          class="start-select"
          :options="startOptions"
          data-testid="add-worktree-start"
        />
      </template>
      <label for="add-worktree-path" class="text-md text-fg-secondary">
        {{ t("worktrees.add.path") }}
      </label>
      <Input
        id="add-worktree-path"
        v-model="form.path.value"
        :error="pathError"
        data-testid="add-worktree-path"
        @input="form.editPath()"
      />
      <p class="col-start-2 text-sm text-fg-muted" data-testid="add-worktree-help">
        {{ t("worktrees.add.help", { folder: worktrees.worktreeFolder }) }}
      </p>
      <ErrorBanner
        v-if="failure"
        class="col-span-2"
        :message="failure.message"
        :output="failure.output"
        open
        data-testid="add-worktree-error"
      />
    </form>
  </Dialog>
</template>

<style scoped>
/* A 100px label column, the branch select 132px wide beside the
   name field, "Start from" 200px wide. Off the spacing scale. */
.add-worktree-grid {
  grid-template-columns: 100px minmax(0, 1fr);
}
.branch-select {
  width: 132px;
}
.start-select {
  width: 200px;
}
</style>
