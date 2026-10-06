<script setup lang="ts">
// The commit box under the lists: the subject with its count past 72 characters, the
// description, "Amend last commit" (HEAD's message borrowed into an empty box, off on an unborn
// branch), "Sign off" and "Push after commit" as icon toggles beside the author line git will use
// (or the commit being amended), and "Commit" with ⌘↵, enabled only with a subject and something
// to commit. "Push after commit" is a setting: pressed, the button reads "Commit and push" and
// the commit is followed by a push; when the push cannot run (`pushPlan`) the toggle is
// unavailable, its tooltip saying why, and the commit goes alone.
// The draft lives in the store, so leaving the screen keeps it. In the folder view a line above
// the fields reads "Commit to" with the repository and its branch.

import { PencilLine, Signature, Upload } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import Kbd from "@/components/Kbd.vue";
import LaneDot from "@/components/LaneDot.vue";
import Textarea from "@/components/Textarea.vue";
import { shortHash } from "@/shell/format";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";

import { useChanges, useOpenRepositoryChanges } from "./useChanges";
import { useCommitAndPush } from "./useCommitAndPush";

const props = withDefaults(
  defineProps<{
    /** The repository the box commits, named above its fields with its branch. */
    targetName?: string;
    /** That repository's branch ("detached HEAD" when detached); none when unknown. */
    targetBranch?: string;
    /** The branch's lane dot; 0 for none. */
    targetLane?: number;
  }>(),
  { targetName: "", targetBranch: "", targetLane: 0 },
);

/** Git wraps the subject at this width in its logs; the count shows past it. */
const SUBJECT_WIDTH = 72;

const { t, n } = useI18n();
const changes = useChanges();
const repo = useRepoStore();
const settings = useSettingsStore();
const pushing = useCommitAndPush();
/** HEAD's hash is known for the open repository only (its refs are listed). */
const openRepository = useOpenRepositoryChanges();
const commitHint = useShortcutHint("commit");

const subject = computed({
  get: () => changes.draft.subject,
  set: (value: string) => changes.setDraft({ subject: value }),
});
const body = computed({
  get: () => changes.draft.body,
  set: (value: string) => changes.setDraft({ body: value }),
});
const unborn = computed(() => changes.context?.unborn ?? false);
/** The box is inert while a write runs and on a clean tree. */
const inert = computed(() => changes.blocking || changes.isEmpty);
const subjectLength = computed(() => [...changes.draft.subject].length);
const overWidth = computed(() => subjectLength.value > SUBJECT_WIDTH);
const headHash = computed(() =>
  openRepository ? (repo.currentBranch?.target ?? repo.commits[0]?.hash ?? null) : null,
);

/** The author line: who git signs the commit as, or the commit being amended and by whom. */
const authorLine = computed(() => {
  const author = changes.context?.author ?? "";
  if (changes.draft.amend && headHash.value) {
    return t("changes.amends", {
      hash: shortHash(headHash.value),
      author: author.replace(/\s*<.*$/, ""),
    });
  }
  if (unborn.value && author) return t("changes.unbornAuthor", { author });
  return author;
});

/** Why the push cannot run, as the toggle's tooltip and description; empty when it can. */
const pushRefusal = computed(() => {
  const plan = pushing.planFor(changes);
  return plan.kind === "refused" ? t(`changes.pushRefused.${plan.reason}`) : "";
});
const willPush = computed(() => pushing.willPush(changes));
const buttonLabel = computed(() => {
  if (changes.draft.amend)
    return willPush.value ? t("changes.amendAndPush") : t("changes.amendButton");
  return willPush.value ? t("changes.commitAndPush") : t("changes.commit");
});

function onSubmit(): void {
  void pushing.submit(changes);
}

/** Enter alone in the subject stays put: the commit key is ⌘↵ (the registry runs it). */
function onSubjectKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) event.preventDefault();
}
</script>

<template>
  <form
    class="flex shrink-0 flex-col gap-3 border-t border-line p-3"
    data-testid="commit-box"
    @submit.prevent="onSubmit"
  >
    <!-- "Commit to", the repository and its branch with its lane dot. -->
    <span
      v-if="props.targetName"
      class="flex min-w-0 items-center gap-2 text-sm"
      data-testid="commit-target"
    >
      <span class="shrink-0 text-fg-muted">{{ t("changes.commitTo") }}</span>
      <span class="truncate font-medium text-fg">{{ props.targetName }}</span>
      <span v-if="props.targetBranch" class="flex min-w-0 items-center gap-2 text-fg-secondary">
        <LaneDot v-if="props.targetLane > 0" :lane="props.targetLane" />
        <span class="truncate">{{ props.targetBranch }}</span>
      </span>
    </span>
    <!-- Subject and description sit 8px apart, the rest 12px. -->
    <div class="flex flex-col gap-2">
      <div class="flex flex-col gap-1">
        <Input
          v-model="subject"
          :placeholder="t('changes.subject')"
          :disabled="inert"
          name="subject"
          data-testid="commit-subject"
          @keydown="onSubjectKeydown"
        />
        <span
          v-if="overWidth"
          class="text-right text-sm text-warn"
          data-testid="commit-subject-over"
        >
          {{ t("changes.subjectOver", { n: n(subjectLength) }) }}
        </span>
      </div>
      <Textarea
        v-model="body"
        :placeholder="t('changes.body')"
        :disabled="inert"
        :rows="4"
        name="body"
        data-testid="commit-body"
      />
    </div>
    <!-- The toggles before the author line, pressed while on, since they carry no words: Amend
         and Sign off change the commit the line names, Push after commit what follows it. Commit
         has the last row, so the author line keeps its width in the 280px column. -->
    <div class="flex items-center gap-3">
      <div class="flex shrink-0 items-center gap-1">
        <IconButton
          :label="t('changes.amend')"
          :icon="PencilLine"
          :pressed="changes.draft.amend"
          :disabled="unborn || inert"
          data-testid="commit-amend"
          @click="changes.setDraft({ amend: !changes.draft.amend })"
        />
        <IconButton
          :label="t('changes.signOff')"
          :icon="Signature"
          :pressed="changes.draft.signoff"
          :disabled="inert"
          data-testid="commit-signoff"
          @click="changes.setDraft({ signoff: !changes.draft.signoff })"
        />
        <IconButton
          :label="t('changes.pushAfterCommit')"
          :icon="Upload"
          :pressed="settings.values.pushAfterCommit"
          :disabled="inert"
          :unavailable="pushRefusal"
          data-testid="commit-push"
          @click="() => void settings.update('pushAfterCommit', !settings.values.pushAfterCommit)"
        />
      </div>
      <span
        class="min-w-0 flex-1 truncate text-sm"
        :class="inert ? 'text-fg-disabled' : 'text-fg-muted'"
        :data-tooltip="changes.context?.author || undefined"
        data-testid="commit-author"
      >
        {{ authorLine }}
      </span>
    </div>
    <div class="flex items-center justify-end gap-3">
      <Kbd :keys="commitHint" />
      <Button
        type="submit"
        variant="primary"
        :disabled="!changes.canCommit"
        data-testid="commit-button"
      >
        {{ buttonLabel }}
      </Button>
    </div>
  </form>
</template>
