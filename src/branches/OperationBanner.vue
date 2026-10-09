<script setup lang="ts">
// The banner under the top bar while an operation is in progress: the
// operation and its source, the conflict count, the hint, "Resolve…" from any other screen,
// "Skip" where git has one, "Abort <operation>…" (confirmed once) and "Continue" (disabled
// while a conflict remains). A refused continue shows git's words under the banner, and a stash
// git's autostash holds aside the line that says when the changes come back; conflicts that
// came back from a kept stash are KeptStashBanner's. The confirmation of a conflicted file
// taken whole from one side, asked from any screen, is here.

import { GitMerge } from "@lucide/vue";
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import { useChangesStore } from "@/stores/changes";
import { useLocalChangesStore } from "@/stores/localChanges";
import { useRepoStore } from "@/stores/repo";
import { useSequencerStore } from "@/stores/sequencer";
import { useShellStore } from "@/stores/shell";

import SequencerFailure from "./SequencerFailure.vue";
import { useSideTexts } from "./useSideTexts";

const { t } = useI18n();
const sequencer = useSequencerStore();
const changes = useChangesStore();
const repo = useRepoStore();
const shell = useShellStore();
const sideTexts = useSideTexts();
const localChanges = useLocalChangesStore();

/** When the changes git's autostash holds aside come back. */
const heldAside = computed(() =>
  sequencer.heldAside !== null &&
  (sequencer.operation === "merge" || sequencer.operation === "rebase")
    ? t(`localChanges.heldAside.${sequencer.operation}`)
    : "",
);

/** The confirmation of a side taken, while its file is still conflicted. */
const takeDialog = computed(() => {
  const prompt = sequencer.takePrompt;
  const sides = sequencer.sides;
  if (!prompt || !sides) return null;
  const conflict = sequencer.conflicts.find((entry) => entry.path === prompt.path);
  if (!conflict) return null;
  return sideTexts.confirmation(sides, conflict.path, conflict.kind, prompt.side);
});

// A reload that took the file out of the conflicts (resolved elsewhere) closes the question.
watch(takeDialog, (dialog) => {
  if (dialog === null && sequencer.takePrompt !== null) sequencer.dismissTakeSide();
});

const operationName = computed(() => t(`sequencer.operations.${sequencer.operation}`));
const branch = computed(() => repo.currentBranch?.name ?? "HEAD");

/** The branch a merge in progress brings in, from the message git prepared ("Merge branch 'x'"). */
const mergeSource = computed(() => {
  const prepared = changes.context?.preparedMessage ?? "";
  const match = /^Merge (?:remote-tracking branch|branch|tag) '([^']+)'/.exec(prepared);
  return match?.[1] ?? null;
});

const title = computed(() => {
  const n = sequencer.conflictCount;
  const suffix = n > 0 ? ` · ${t("sequencer.banner.conflicts", { n }, n)}` : "";
  if (sequencer.operation === "merge") {
    const source = mergeSource.value;
    const head = source
      ? t("sequencer.banner.merge", { source, branch: branch.value })
      : t("sequencer.banner.mergeUnknown", { branch: branch.value });
    return `${head}${suffix}`;
  }
  return `${t(`sequencer.banner.${sequencer.operation}`, { branch: branch.value })}${suffix}`;
});

/** What to do next; with no operation (a stash that came back with conflicts) nothing to
 * continue. */
const hint = computed(() => {
  if (sequencer.operation === "none") return t("sequencer.banner.hintNoOperation");
  return sequencer.conflictCount > 0 ? t("sequencer.banner.hint") : t("sequencer.banner.hintClean");
});

// The merge's source comes from the message git prepared, which the changes screen loads;
// the banner needs it on every screen.
watch(
  () => sequencer.inProgress,
  (inProgress) => {
    if (inProgress) void changes.loadContext();
  },
  { immediate: true },
);

function confirmAbort(): void {
  sequencer.dismissAbort();
  void sequencer.act("abort");
}
</script>

<template>
  <div
    v-if="sequencer.inProgress && !localChanges.keptShown"
    role="status"
    class="flex flex-col border-b border-line bg-raised"
    data-testid="operation-banner"
  >
    <div class="flex h-bar-top items-center gap-3 px-3 whitespace-nowrap">
      <GitMerge :size="16" :stroke-width="1.5" aria-hidden="true" class="shrink-0 text-warn" />
      <span class="text-md font-medium text-fg" data-testid="operation-title">{{ title }}</span>
      <span class="min-w-0 truncate text-sm text-fg-muted" data-testid="operation-hint">
        {{ hint }}
      </span>
      <span
        v-if="heldAside"
        class="min-w-0 truncate text-sm text-fg-muted"
        data-testid="operation-held-aside"
      >
        {{ heldAside }}
      </span>
      <div class="ml-auto flex items-center gap-3">
        <Button
          v-if="shell.layoutMode !== 'changes'"
          variant="ghost"
          data-testid="operation-resolve"
          @click="() => void shell.setLayoutMode('changes')"
        >
          {{ t("sequencer.banner.resolve") }}
        </Button>
        <Button
          v-if="sequencer.canSkip"
          variant="ghost"
          :disabled="sequencer.busy"
          data-testid="operation-skip"
          @click="() => void sequencer.act('skip')"
        >
          {{ t("sequencer.banner.skip") }}
        </Button>
        <Button
          v-if="sequencer.operation !== 'none'"
          variant="secondary"
          :disabled="sequencer.busy"
          data-testid="operation-abort"
          @click="sequencer.askAbort()"
        >
          {{ t("sequencer.banner.abort", { operation: operationName.toLowerCase() }) }}
        </Button>
        <Button
          v-if="sequencer.operation !== 'none'"
          variant="primary"
          :disabled="!sequencer.canContinue || sequencer.busy"
          data-testid="operation-continue"
          @click="() => void sequencer.act('continue')"
        >
          {{ t("sequencer.banner.continue") }}
        </Button>
      </div>
    </div>
    <SequencerFailure />
  </div>
  <!-- Outside the banner's live region, which would read a dialog in it once more. -->
  <Dialog
    v-if="sequencer.inProgress && sequencer.abortPrompt"
    :title="t('sequencer.banner.abortTitle', { operation: operationName.toLowerCase() })"
    :body="t('sequencer.banner.abortBody')"
    :confirm-label="t('sequencer.banner.abortConfirm', { operation: operationName.toLowerCase() })"
    variant="destructive"
    data-testid="abort-dialog"
    @confirm="confirmAbort"
    @cancel="sequencer.dismissAbort()"
  />
  <Dialog
    v-if="takeDialog"
    :title="takeDialog.title"
    :body="takeDialog.body"
    :confirm-label="takeDialog.confirm"
    :confirm-disabled="sequencer.busy"
    variant="destructive"
    data-testid="take-side-dialog"
    @confirm="() => void sequencer.takeSide()"
    @cancel="sequencer.dismissTakeSide()"
  />
</template>
