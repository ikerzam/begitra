<script setup lang="ts">
// The delete confirmations of the branch actions, from `branches.prompt`. A local branch's:
// "Delete <remote>/<branch> too" when it has an upstream (unticked), and "Delete anyway" with
// git's refusal and the reflog note, which keeps the tick. A tag's: tags have no reflog, and
// "Delete it on <remote> too", with the remote to pick when there are several (the current
// branch's first). A delete on a remote runs after the local one succeeds.

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import Dialog from "@/components/Dialog.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import { useBranchesStore } from "@/stores/branches";
import { useRemotesStore } from "@/stores/remotes";

const { t } = useI18n();
const branches = useBranchesStore();
const remotes = useRemotesStore();

const alsoRemote = ref(false);
const tagRemote = ref("");

const remoteOptions = computed<SelectOption[]>(() =>
  remotes.preferred.map((name) => ({ value: name, label: name })),
);

// Each prompt starts its fields afresh; "Delete anyway" keeps what the first dialog asked.
watch(
  () => branches.prompt,
  (prompt) => {
    alsoRemote.value = prompt?.kind === "delete" ? (prompt.alsoRemote ?? false) : false;
    tagRemote.value = remotes.preferred[0] ?? "";
  },
  { immediate: true },
);
// The remotes may be listed after the dialog opened.
watch(
  () => remotes.preferred,
  (names) => {
    if (!names.includes(tagRemote.value)) tagRemote.value = names[0] ?? "";
  },
);

function confirm(): void {
  const prompt = branches.prompt;
  if (prompt?.kind === "delete") {
    void branches.remove(prompt.name, prompt.force, prompt.remote ?? null, alsoRemote.value);
  } else if (prompt?.kind === "deleteTag") {
    const remote = alsoRemote.value && tagRemote.value !== "" ? tagRemote.value : null;
    void branches.deleteTag(prompt.name, remote);
  }
}
</script>

<template>
  <Dialog
    v-if="branches.prompt?.kind === 'delete'"
    :title="
      branches.prompt.force
        ? t('branches.dialogs.deleteAnywayTitle', { name: branches.prompt.name })
        : t('branches.dialogs.deleteTitle', { name: branches.prompt.name })
    "
    :body="
      branches.prompt.force
        ? t('branches.dialogs.deleteAnywayBody')
        : t('branches.dialogs.deleteBody')
    "
    :confirm-label="
      branches.prompt.force ? t('branches.dialogs.deleteAnyway') : t('branches.dialogs.delete')
    "
    variant="destructive"
    data-testid="branch-delete-dialog"
    @confirm="confirm"
    @cancel="branches.dismiss()"
  >
    <div v-if="branches.prompt.output || branches.prompt.remote" class="flex flex-col gap-3">
      <ErrorBanner
        v-if="branches.prompt.output"
        :message="t('branches.failed', { message: '' }).trim()"
        :output="branches.prompt.output"
        open
      />
      <template v-if="branches.prompt.remote">
        <Checkbox
          v-model="alsoRemote"
          :label="
            t('branches.dialogs.deleteOnRemoteToo', {
              ref: `${branches.prompt.remote.remote}/${branches.prompt.remote.name}`,
            })
          "
          data-testid="branch-delete-remote"
        />
        <p
          v-if="alsoRemote"
          class="text-md text-fg-secondary"
          data-testid="branch-delete-remote-consequence"
        >
          {{
            t("branches.dialogs.onRemoteConsequence", {
              name: branches.prompt.remote.name,
              remote: branches.prompt.remote.remote,
            })
          }}
        </p>
      </template>
    </div>
  </Dialog>

  <Dialog
    v-else-if="branches.prompt?.kind === 'deleteTag'"
    :title="t('branches.dialogs.deleteTagTitle', { name: branches.prompt.name })"
    :body="t('branches.dialogs.deleteTagBody')"
    :confirm-label="t('branches.dialogs.deleteTag')"
    variant="destructive"
    data-testid="tag-delete-dialog"
    @confirm="confirm"
    @cancel="branches.dismiss()"
  >
    <div v-if="remoteOptions.length > 0" class="flex flex-col gap-3">
      <Checkbox
        v-model="alsoRemote"
        :label="t('branches.dialogs.deleteTagOnRemoteToo', { remote: tagRemote })"
        data-testid="tag-delete-remote"
      />
      <p v-if="alsoRemote" class="text-md text-fg-secondary" data-testid="tag-delete-consequence">
        {{
          t("branches.dialogs.onRemoteConsequence", {
            name: branches.prompt.name,
            remote: tagRemote,
          })
        }}
      </p>
      <div v-if="alsoRemote && remoteOptions.length > 1" class="flex flex-col gap-1">
        <label for="tag-delete-remote-name" class="text-md text-fg-secondary">
          {{ t("remotes.pushDialog.remote") }}
        </label>
        <Select
          id="tag-delete-remote-name"
          v-model="tagRemote"
          :options="remoteOptions"
          data-testid="tag-delete-remote-name"
        />
      </div>
    </div>
  </Dialog>
</template>
