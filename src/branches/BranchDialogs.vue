<script setup lang="ts">
// The dialogs of the branch actions, one at a time from `branches.prompt`: create (name,
// checkout), rename, set upstream, tag, reset (soft, mixed or hard, as radios)
// and "Stash and switch" after a dirty switch was refused; the deletes of a branch and of a
// tag are DeleteDialogs', the undo of a pushed commit UndoCommitDialog's, a branch another
// worktree holds HeldWorktreeDialog's. Each confirms through the store.

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import Dialog from "@/components/Dialog.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import Input from "@/components/Input.vue";
import RadioGroup from "@/components/RadioGroup.vue";
import Select from "@/components/Select.vue";
import Textarea from "@/components/Textarea.vue";
import type { RadioOption, SelectOption } from "@/components/types";
import type { ResetMode } from "@/ipc/schemas";
import { shortHash } from "@/shell/format";
import { targetName, useBranchesStore } from "@/stores/branches";
import { useChangesStore } from "@/stores/changes";
import { useRepoStore } from "@/stores/repo";

import DeleteDialogs from "./DeleteDialogs.vue";
import HeldWorktreeDialog from "./HeldWorktreeDialog.vue";
import { validName } from "./names";
import UndoCommitDialog from "./UndoCommitDialog.vue";

const { t } = useI18n();
const branches = useBranchesStore();
const repo = useRepoStore();
const changes = useChangesStore();

const resetModes = computed<RadioOption[]>(() =>
  (["soft", "mixed", "hard"] as const).map((option) => ({
    value: option,
    label: t(`branches.dialogs.${option}`),
    hint: t(`branches.dialogs.${option}Hint`),
  })),
);
const resetMode = computed({
  get: () => mode.value,
  set: (value: string) => {
    if (value === "soft" || value === "mixed" || value === "hard") mode.value = value;
  },
});

const name = ref("");
const checkout = ref(true);
const message = ref("");
const upstream = ref("");
const mode = ref<ResetMode>("mixed");

const nameInvalid = computed(() => name.value.trim() !== "" && !validName(name.value));
const nameError = computed(() => (nameInvalid.value ? t("branches.dialogs.invalidName") : ""));

const remoteBranches = computed<SelectOption[]>(() => [
  { value: "", label: t("branches.dialogs.noUpstream") },
  ...repo.refs
    .filter((entry) => entry.kind === "remote-branch")
    .map((entry) => ({ value: entry.name, label: entry.name })),
]);

// Each prompt starts its fields afresh; the reset dialog counts the uncommitted changes.
watch(
  () => branches.prompt,
  (prompt) => {
    name.value = prompt?.kind === "rename" ? prompt.name : "";
    checkout.value = true;
    message.value = "";
    upstream.value = prompt?.kind === "upstream" ? (prompt.current ?? "") : "";
    mode.value = "mixed";
    if (prompt?.kind === "reset" && !changes.loaded) void changes.load();
  },
);

function resetLabel(): string {
  return t("branches.dialogs.reset", { mode: t(`branches.dialogs.${mode.value}`).toLowerCase() });
}

/** The reset sentence names the uncommitted changes when the lists are loaded. */
const resetBody = computed(() => {
  const prompt = branches.prompt;
  if (prompt?.kind !== "reset") return "";
  const count = changes.unstagedCount + changes.stagedCount;
  const params = { branch: prompt.branch, rev: prompt.label, n: count };
  return changes.loaded && count > 0
    ? t("branches.dialogs.resetBodyChanges", params, count)
    : t("branches.dialogs.resetBody", params);
});

function confirm(): void {
  const prompt = branches.prompt;
  if (!prompt) return;
  switch (prompt.kind) {
    case "create":
      if (validName(name.value))
        void branches.create(name.value.trim(), prompt.start, checkout.value);
      break;
    case "rename":
      if (validName(name.value)) void branches.rename(prompt.name, name.value.trim());
      break;
    case "upstream":
      void branches.setUpstream(prompt.branch, upstream.value === "" ? null : upstream.value);
      break;
    case "tag":
      if (validName(name.value)) {
        void branches.tag(
          name.value.trim(),
          prompt.rev,
          message.value.trim() === "" ? null : message.value.trim(),
        );
      }
      break;
    case "reset":
      void branches.reset(prompt.rev, mode.value);
      break;
    case "dirtySwitch":
      void branches.stashAndSwitch(prompt.target, prompt.tracking);
      break;
  }
}
</script>

<template>
  <template v-if="branches.prompt">
    <Dialog
      v-if="branches.prompt.kind === 'create'"
      :title="t('branches.dialogs.createTitle')"
      :body="t('branches.dialogs.createBody', { start: branches.prompt.startLabel })"
      :confirm-label="t('branches.dialogs.create')"
      :confirm-disabled="!validName(name)"
      data-testid="branch-create-dialog"
      @confirm="confirm"
      @cancel="branches.dismiss()"
    >
      <form class="flex flex-col gap-3" @submit.prevent="confirm">
        <label class="flex flex-col gap-1 text-md text-fg-secondary">
          {{ t("branches.dialogs.name") }}
          <Input
            v-model="name"
            :placeholder="t('branches.dialogs.namePlaceholder')"
            :error="nameError"
            data-autofocus
            data-testid="branch-name"
          />
        </label>
        <Checkbox
          v-model="checkout"
          :label="t('branches.dialogs.checkout')"
          data-testid="branch-checkout"
        />
      </form>
    </Dialog>

    <Dialog
      v-else-if="branches.prompt.kind === 'rename'"
      :title="t('branches.dialogs.renameTitle', { name: branches.prompt.name })"
      :confirm-label="t('branches.dialogs.rename')"
      :confirm-disabled="!validName(name) || name.trim() === branches.prompt.name"
      data-testid="branch-rename-dialog"
      @confirm="confirm"
      @cancel="branches.dismiss()"
    >
      <form class="flex flex-col gap-3" @submit.prevent="confirm">
        <label class="flex flex-col gap-1 text-md text-fg-secondary">
          {{ t("branches.dialogs.name") }}
          <Input v-model="name" :error="nameError" data-autofocus data-testid="branch-name" />
        </label>
      </form>
    </Dialog>

    <DeleteDialogs
      v-else-if="branches.prompt.kind === 'delete' || branches.prompt.kind === 'deleteTag'"
    />

    <Dialog
      v-else-if="branches.prompt.kind === 'upstream'"
      :title="t('branches.dialogs.upstreamTitle', { branch: branches.prompt.branch })"
      :body="t('branches.dialogs.upstreamBody')"
      :confirm-label="t('branches.dialogs.setUpstream')"
      data-testid="branch-upstream-dialog"
      @confirm="confirm"
      @cancel="branches.dismiss()"
    >
      <div class="flex flex-col gap-1">
        <label for="branch-upstream" class="text-md text-fg-secondary">
          {{ t("branches.dialogs.upstream") }}
        </label>
        <Select
          id="branch-upstream"
          v-model="upstream"
          :options="remoteBranches"
          data-autofocus
          data-testid="branch-upstream"
        />
      </div>
    </Dialog>

    <Dialog
      v-else-if="branches.prompt.kind === 'tag'"
      :title="t('branches.dialogs.tagTitle', { label: branches.prompt.label })"
      :body="t('branches.dialogs.tagBody')"
      :confirm-label="t('branches.dialogs.tag')"
      :confirm-disabled="!validName(name)"
      data-testid="tag-dialog"
      @confirm="confirm"
      @cancel="branches.dismiss()"
    >
      <form class="flex flex-col gap-3" @submit.prevent="confirm">
        <label class="flex flex-col gap-1 text-md text-fg-secondary">
          {{ t("branches.dialogs.tagName") }}
          <Input v-model="name" :error="nameError" data-autofocus data-testid="tag-name" />
        </label>
        <label class="flex flex-col gap-1 text-md text-fg-secondary">
          {{ t("branches.dialogs.tagMessage") }}
          <Textarea v-model="message" :rows="3" data-testid="tag-message" />
        </label>
      </form>
    </Dialog>

    <Dialog
      v-else-if="branches.prompt.kind === 'reset'"
      :title="
        t('branches.dialogs.resetTitle', {
          branch: branches.prompt.branch,
          rev: shortHash(branches.prompt.rev),
        })
      "
      :body="resetBody"
      :confirm-label="resetLabel()"
      :variant="mode === 'hard' ? 'destructive' : 'default'"
      data-testid="reset-dialog"
      @confirm="confirm"
      @cancel="branches.dismiss()"
    >
      <!-- 14px radio boxes: one tab stop, the arrows move between the modes. -->
      <RadioGroup
        v-model="resetMode"
        :options="resetModes"
        :label="t('branches.dialogs.resetModes')"
        data-testid="reset-modes"
      />
    </Dialog>

    <UndoCommitDialog v-else-if="branches.prompt.kind === 'undoCommit'" />
    <HeldWorktreeDialog v-else-if="branches.prompt.kind === 'heldElsewhere'" />
    <Dialog
      v-else-if="branches.prompt.kind === 'dirtySwitch'"
      :title="t('branches.dialogs.dirtySwitchTitle')"
      :body="t('branches.dialogs.dirtySwitchBody', { name: targetName(branches.prompt.target) })"
      :confirm-label="t('branches.dialogs.stashAndSwitch')"
      data-testid="dirty-switch-dialog"
      @confirm="confirm"
      @cancel="branches.dismiss()"
    >
      <ErrorBanner
        :message="t('branches.failed', { message: '' }).trim()"
        :output="branches.prompt.output"
        open
      />
    </Dialog>
  </template>
</template>
