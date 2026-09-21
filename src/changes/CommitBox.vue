<script setup lang="ts">
// The commit box under the lists: the subject with its count
// past 72 characters, the description, "Amend last commit" (HEAD's message borrowed into an
// empty box, off on an unborn branch) and "Sign off", the author line git will use (or the
// commit being amended), and "Commit" with ⌘↵, enabled only with a subject and something to
// commit. The draft lives in the store, so leaving the screen keeps it.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Checkbox from "@/components/Checkbox.vue";
import Input from "@/components/Input.vue";
import Kbd from "@/components/Kbd.vue";
import Textarea from "@/components/Textarea.vue";
import { shortHash } from "@/shell/format";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import { useChangesStore } from "@/stores/changes";
import { useRepoStore } from "@/stores/repo";

/** Git wraps the subject at this width in its logs; the count shows past it. */
const SUBJECT_WIDTH = 72;

const { t, n } = useI18n();
const changes = useChangesStore();
const repo = useRepoStore();
const commitHint = useShortcutHint("commit");

const subject = computed({
  get: () => changes.draft.subject,
  set: (value: string) => changes.setDraft({ subject: value }),
});
const body = computed({
  get: () => changes.draft.body,
  set: (value: string) => changes.setDraft({ body: value }),
});
const amend = computed({
  get: () => changes.draft.amend,
  set: (value: boolean) => changes.setDraft({ amend: value }),
});
const signoff = computed({
  get: () => changes.draft.signoff,
  set: (value: boolean) => changes.setDraft({ signoff: value }),
});
const unborn = computed(() => changes.context?.unborn ?? false);
/** The box is inert while a write runs and on a clean tree. */
const inert = computed(() => changes.busy !== null || changes.isEmpty);
const subjectLength = computed(() => [...changes.draft.subject].length);
const overWidth = computed(() => subjectLength.value > SUBJECT_WIDTH);
const headHash = computed(() => repo.currentBranch?.target ?? repo.commits[0]?.hash ?? null);

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

function onSubmit(): void {
  void changes.commit();
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
    <div class="flex items-center gap-4">
      <Checkbox
        v-model="amend"
        :label="t('changes.amend')"
        :disabled="unborn || inert"
        data-testid="commit-amend"
      />
      <Checkbox
        v-model="signoff"
        :label="t('changes.signOff')"
        :disabled="inert"
        data-testid="commit-signoff"
      />
    </div>
    <div class="flex items-center gap-3">
      <span
        class="min-w-0 flex-1 truncate text-sm"
        :class="inert ? 'text-fg-disabled' : 'text-fg-muted'"
        :title="changes.context?.author ?? ''"
        data-testid="commit-author"
      >
        {{ authorLine }}
      </span>
      <Kbd :keys="commitHint" />
      <Button
        type="submit"
        variant="primary"
        :disabled="!changes.canCommit"
        data-testid="commit-button"
      >
        {{ changes.draft.amend ? t("changes.amendButton") : t("changes.commit") }}
      </Button>
    </div>
  </form>
</template>
