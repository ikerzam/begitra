<script setup lang="ts">
// The add-worktree dialog: Branch (a new branch with its name, or a local branch no worktree
// has checked out), Start from (a new branch only; the current branch by default), Path
// (the worktree folder plus the branch name, slashes as dashes; editable; refused when the
// folder exists) and, when git refuses, its output inline while the dialog stays open.

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import Input from "@/components/Input.vue";
import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import * as ipc from "@/ipc/commands";
import type { WorktreeAdd } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { useRepoStore } from "@/stores/repo";
import { useWorktreesStore } from "@/stores/worktrees";

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const repo = useRepoStore();
const worktrees = useWorktreesStore();

const NEW_BRANCH = "?new"; // never a branch name: git refuses "?" in refnames

/** Local branches no worktree has checked out. */
const freeBranches = computed(() =>
  repo.refs.filter((ref) => ref.kind === "local-branch" && ref.worktree === null),
);
const branchOptions = computed<SelectOption[]>(() => [
  { value: NEW_BRANCH, label: t("worktrees.add.newBranch") },
  ...freeBranches.value.map((ref) => ({ value: ref.name, label: ref.name })),
]);
const startOptions = computed<SelectOption[]>(() =>
  repo.refs
    .filter((ref) => ref.kind === "local-branch")
    .map((ref) => ({ value: ref.name, label: ref.name })),
);

const branch = ref(NEW_BRANCH);
const name = ref("");
const start = ref(repo.currentBranch?.name ?? startOptions.value[0]?.value ?? "HEAD");
const path = ref("");
const pathEdited = ref(false);
const pathExists = ref(false);
const submitting = ref(false);

const isNew = computed(() => branch.value === NEW_BRANCH);
const branchName = computed(() => (isNew.value ? name.value.trim() : branch.value));

// The path follows the branch until the user edits it.
watch(
  branchName,
  (value) => {
    if (!pathEdited.value) path.value = value ? worktrees.defaultPath(value) : "";
  },
  { immediate: true },
);

let check = 0;
watch(path, (value) => {
  check += 1;
  const mine = check;
  pathExists.value = false;
  const trimmed = value.trim();
  if (!trimmed) return;
  void ipc
    .pathExists(trimmed)
    .then((exists) => {
      if (mine === check) pathExists.value = exists;
    })
    .catch(() => undefined);
});

const nameError = computed(() => {
  if (!isNew.value || name.value === "") return "";
  const value = name.value.trim();
  if (value.startsWith("-") || value.includes("..") || /[\s~^:?*[\\]/.test(value)) {
    return t("worktrees.add.invalidName");
  }
  return "";
});
const pathError = computed(() => (pathExists.value ? t("worktrees.add.folderExists") : ""));
const canSubmit = computed(
  () =>
    branchName.value !== "" &&
    nameError.value === "" &&
    path.value.trim() !== "" &&
    pathError.value === "" &&
    !submitting.value,
);
const failure = computed(() => {
  const error = worktrees.error;
  if (!error) return null;
  const text = errorText(error);
  return { message: t(text.key, text.params), output: error.detail ?? "" };
});

function onPathInput(): void {
  pathEdited.value = true;
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  const request: WorktreeAdd = {
    path: path.value.trim(),
    branch: isNew.value
      ? { kind: "new", name: branchName.value, start: start.value }
      : { kind: "existing", name: branchName.value },
  };
  submitting.value = true;
  try {
    const added = await worktrees.add(request);
    if (added) emit("close");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Dialog
    :title="t('worktrees.add.title')"
    :body="t('worktrees.add.body')"
    :confirm-label="t('worktrees.add.confirm')"
    :confirm-disabled="!canSubmit"
    @confirm="() => void submit()"
    @cancel="emit('close')"
  >
    <form class="flex flex-col gap-4" data-testid="add-worktree-form" @submit.prevent="submit">
      <div class="add-worktree-grid grid items-center gap-3">
        <label :for="'add-worktree-branch'" class="text-md text-fg-secondary">
          {{ t("worktrees.add.branch") }}
        </label>
        <div class="flex items-center gap-3">
          <Select
            id="add-worktree-branch"
            v-model="branch"
            :options="branchOptions"
            :label="t('worktrees.add.branch')"
            data-testid="add-worktree-branch"
          />
          <Input
            v-if="isNew"
            v-model="name"
            :placeholder="t('worktrees.add.namePlaceholder')"
            :error="nameError"
            data-autofocus
            data-testid="add-worktree-name"
          />
        </div>
        <template v-if="isNew">
          <label for="add-worktree-start" class="text-md text-fg-secondary">
            {{ t("worktrees.add.startFrom") }}
          </label>
          <Select
            id="add-worktree-start"
            v-model="start"
            :options="startOptions"
            :label="t('worktrees.add.startFrom')"
            data-testid="add-worktree-start"
          />
        </template>
        <label for="add-worktree-path" class="text-md text-fg-secondary">
          {{ t("worktrees.add.path") }}
        </label>
        <Input
          id="add-worktree-path"
          v-model="path"
          :error="pathError"
          data-testid="add-worktree-path"
          @input="onPathInput"
        />
      </div>
      <p class="text-sm text-fg-muted" data-testid="add-worktree-help">
        {{ t("worktrees.add.help", { folder: worktrees.worktreeFolder }) }}
      </p>
      <ErrorBanner
        v-if="failure"
        :message="failure.message"
        :output="failure.output"
        open
        data-testid="add-worktree-error"
      />
    </form>
  </Dialog>
</template>

<style scoped>
/* The labels column is 140px; off the spacing scale. */
.add-worktree-grid {
  grid-template-columns: 140px minmax(0, 1fr);
}
</style>
