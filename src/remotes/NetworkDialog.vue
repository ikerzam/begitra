<script setup lang="ts">
// The push and pull dialogs: the remote and the branch (the upstream by
// default), "Set upstream" and "Force with lease" for a push, "Rebase" for a pull, the ahead
// or behind count in the sentence, and the confirm that runs the streamed command.

import { Download, Upload } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import Dialog from "@/components/Dialog.vue";
import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import { splitUpstream, useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";

const props = defineProps<{ mode: "push" | "pull"; branch: string }>();

const { t, n } = useI18n();
const remotes = useRemotesStore();
const repo = useRepoStore();

const ref_ = computed(() =>
  repo.refs.find((entry) => entry.kind === "local-branch" && entry.name === props.branch),
);
const upstream = computed(() => splitUpstream(ref_.value?.upstream ?? null));
const remote = ref(upstream.value?.remote ?? remotes.remotes[0]?.name ?? "origin");
const remoteBranch = ref(upstream.value?.branch ?? props.branch);
const setUpstream = ref(upstream.value === null);
const forceWithLease = ref(false);
const rebase = ref(false);

const remoteOptions = computed<SelectOption[]>(() => {
  const names = remotes.remotes.map((entry) => entry.name);
  if (names.length === 0) names.push(remote.value);
  return names.map((name) => ({ value: name, label: name }));
});

/** The branches the chosen remote has (a pull), the local name first when it is not there yet. */
const branchOptions = computed<SelectOption[]>(() => {
  const prefix = `${remote.value}/`;
  const listed = repo.refs
    .filter((entry) => entry.kind === "remote-branch" && entry.name.startsWith(prefix))
    .map((entry) => entry.name.slice(prefix.length));
  const names = listed.includes(remoteBranch.value) ? listed : [remoteBranch.value, ...listed];
  return names.map((name) => ({ value: name, label: `${remote.value}/${name}` }));
});

const count = computed(() => (props.mode === "push" ? ref_.value?.ahead : ref_.value?.behind) ?? 0);
const body = computed(() => {
  const up = ref_.value?.upstream;
  const key = props.mode === "push" ? "remotes.pushDialog" : "remotes.pullDialog";
  return up
    ? t(`${key}.body`, { n: n(count.value), upstream: up }, count.value)
    : t(`${key}.bodyNoUpstream`);
});
const upstreamIs = computed(() => ref_.value?.upstream ?? null);

// The remotes list arrives after the dialog opened: keep a sensible remote selected.
watch(
  () => remotes.remotes,
  (list) => {
    if (!list.some((entry) => entry.name === remote.value) && list[0]) remote.value = list[0].name;
  },
);

function confirm(): void {
  if (props.mode === "push") {
    void remotes.push({
      remote: remote.value,
      branch: props.branch,
      setUpstream: setUpstream.value,
      forceWithLease: forceWithLease.value,
    });
  } else {
    void remotes.pull({ remote: remote.value, branch: remoteBranch.value, rebase: rebase.value });
  }
}
</script>

<template>
  <Dialog
    :title="
      t(props.mode === 'push' ? 'remotes.pushDialog.title' : 'remotes.pullDialog.title', {
        branch: props.branch,
      })
    "
    :body="body"
    :confirm-label="
      t(props.mode === 'push' ? 'remotes.pushDialog.confirm' : 'remotes.pullDialog.confirm')
    "
    :confirm-disabled="remoteOptions.length === 0"
    :confirm-icon="props.mode === 'push' ? Upload : Download"
    :data-testid="`${props.mode}-dialog`"
    @confirm="confirm"
    @cancel="remotes.dismiss()"
  >
    <form class="network-grid grid items-center gap-3" @submit.prevent="confirm">
      <label for="network-remote" class="text-md text-fg-secondary">
        {{ t("remotes.pushDialog.remote") }}
      </label>
      <Select
        id="network-remote"
        v-model="remote"
        class="network-control"
        :options="remoteOptions"
        data-autofocus
        data-testid="network-remote"
      />
      <span id="network-branch-label" class="text-md text-fg-secondary">
        {{ t("remotes.pushDialog.branch") }}
      </span>
      <!-- A push takes the local branch under its own name: the pair is read, not picked. -->
      <span
        v-if="props.mode === 'push'"
        aria-labelledby="network-branch-label"
        class="text-md text-fg-secondary"
        data-testid="network-branch"
      >
        {{ props.branch }} → {{ remote }}/{{ props.branch }}
      </span>
      <Select
        v-else
        v-model="remoteBranch"
        class="network-control"
        :options="branchOptions"
        :label="t('remotes.pushDialog.branch')"
        data-testid="network-branch"
      />
      <template v-if="props.mode === 'push'">
        <Checkbox
          v-model="setUpstream"
          class="col-start-2"
          :label="
            upstreamIs
              ? t('remotes.pushDialog.setUpstreamAlready', { upstream: upstreamIs })
              : t('remotes.pushDialog.setUpstream')
          "
          data-testid="network-set-upstream"
        />
        <Checkbox
          v-model="forceWithLease"
          class="col-start-2"
          :label="t('remotes.pushDialog.forceWithLease', { tracking: `${remote}/${props.branch}` })"
          data-testid="network-force"
        />
      </template>
      <Checkbox
        v-else
        v-model="rebase"
        class="col-start-2"
        :label="t('remotes.pullDialog.rebase')"
        data-testid="network-rebase"
      />
    </form>
  </Dialog>
</template>

<style scoped>
/* The controls start 100px in (88px labels and the 12px gap) and are 200px wide. */
.network-grid {
  grid-template-columns: 88px minmax(0, 1fr);
}

.network-control {
  width: 200px;
}
</style>
