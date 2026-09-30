<script setup lang="ts">
// The dialogs of a ref on a remote, from `remotes.prompt`: "Push tag…" (the remote to push the
// tag to, the current branch's remote first, laid out as the push dialog's fields) and "Delete on
// <remote>…" (a confirmation that names the remote and says the branch leaves it for everyone
// who uses it).

import { Upload } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import { useRemotesStore } from "@/stores/remotes";

const { t } = useI18n();
const remotes = useRemotesStore();

/** The current branch's remote first, then the others in their order. */
const remoteOptions = computed<SelectOption[]>(() =>
  remotes.preferred.map((name) => ({ value: name, label: name })),
);
const remote = ref(remoteOptions.value[0]?.value ?? "");
watch(remoteOptions, (options) => {
  if (!options.some((option) => option.value === remote.value)) {
    remote.value = options[0]?.value ?? "";
  }
});
/** A repository without remotes: the dialog says so, as the remotes sheet does. */
const noRemotes = computed(() => remotes.loaded && remoteOptions.value.length === 0);

function confirm(): void {
  const prompt = remotes.prompt;
  if (prompt?.kind === "pushTag") void remotes.pushTag(prompt.tag, remote.value);
  else if (prompt?.kind === "deleteOnRemote") {
    void remotes.deleteOnRemote({ remote: prompt.remote, branch: prompt.branch, tip: prompt.tip });
  }
}
</script>

<template>
  <Dialog
    v-if="remotes.prompt?.kind === 'pushTag'"
    :title="t('remotes.pushTag.title', { tag: remotes.prompt.tag })"
    :body="noRemotes ? t('remotes.empty') : t('remotes.pushTag.body')"
    :confirm-label="t('remotes.pushTag.confirm')"
    :confirm-disabled="remote === ''"
    :confirm-icon="Upload"
    data-testid="push-tag-dialog"
    @confirm="confirm"
    @cancel="remotes.dismiss()"
  >
    <form v-if="!noRemotes" class="push-tag-grid grid items-center gap-3" @submit.prevent="confirm">
      <label for="push-tag-remote" class="text-md text-fg-secondary">
        {{ t("remotes.pushDialog.remote") }}
      </label>
      <Select
        id="push-tag-remote"
        v-model="remote"
        class="push-tag-control"
        :options="remoteOptions"
        data-autofocus
        data-testid="push-tag-remote"
      />
    </form>
  </Dialog>
  <Dialog
    v-else-if="remotes.prompt?.kind === 'deleteOnRemote'"
    :title="
      t('remotes.deleteOnRemote.title', {
        name: remotes.prompt.branch,
        remote: remotes.prompt.remote,
      })
    "
    :body="
      t('remotes.deleteOnRemote.body', {
        name: remotes.prompt.branch,
        remote: remotes.prompt.remote,
      })
    "
    :confirm-label="t('remotes.deleteOnRemote.confirm', { remote: remotes.prompt.remote })"
    variant="destructive"
    data-testid="delete-on-remote-dialog"
    @confirm="confirm"
    @cancel="remotes.dismiss()"
  />
</template>

<style scoped>
/* The push dialog's layout: an 88px label column, then the 200px control. */
.push-tag-grid {
  grid-template-columns: 88px minmax(0, 1fr);
}

.push-tag-control {
  width: 200px;
}
</style>
