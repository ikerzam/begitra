<script setup lang="ts">
// "Local changes in the way": git refused a switch, a merge, a rebase or a pull over the
// changes in the working tree. The files git named (five, then "and N more"; when it names none,
// as a rebase does, the sentence says the working tree has changes) and its words one click
// away. A switch offers "Bring my changes" (stashed, switched, applied back) and "Leave them in
// a stash", the second first when untracked files are in the way, which a carry could not put
// back over the branch's; a merge, a rebase and a pull "Set them aside and …" (git's autostash);
// untracked files in the way of those three only "Close", naming those files alone, since no
// autostash takes them. ↵ runs the first way through (or closes), Esc cancels.

import { ChevronDown, ChevronRight } from "@lucide/vue";
import { computed, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import { useChangesStore } from "@/stores/changes";
import { useLocalChangesStore, type LocalChangesChoice } from "@/stores/localChanges";
import { useRepoStore } from "@/stores/repo";

import { listsOnOneLine, localChangesIn } from "./localChanges";

/** Files listed before "and N more". */
const SHOWN = 5;

const { t } = useI18n();
const localChanges = useLocalChangesStore();
const changes = useChangesStore();
const repo = useRepoStore();
const outputId = useId();
const filesId = useId();
const moveId = useId();
const outputShown = ref(false);

const question = computed(() => localChanges.prompt);
/** git's lists, merge-ort's one-line list read against the staged files. */
const files = computed(() =>
  localChangesIn(
    question.value?.detail ?? "",
    changes.staged.files.map((file) => file.path),
  ),
);
const switching = computed(() => question.value?.operation === "switch");
/** No way through: untracked files in the way of what git's autostash cannot set aside. */
const blocked = computed(() => files.value.untrackedInTheWay && !switching.value);
/** Untracked files in a switch's way: leaving the changes in a stash comes first. */
const leaveFirst = computed(() => files.value.untrackedInTheWay && switching.value);
/** What the dialog names: the untracked files alone when they are what blocks. */
const named = computed(() =>
  blocked.value ? files.value.untracked : [...files.value.changed, ...files.value.untracked],
);

// Each question opens with git's words folded; a list on one line needs the staged files.
watch(question, (asked) => {
  outputShown.value = false;
  if (asked && listsOnOneLine(asked.detail) && !changes.loaded) changes.load();
});

const body = computed(() => {
  const asked = question.value;
  if (!asked) return "";
  const params = { target: asked.target, branch: repo.currentBranch?.name ?? "HEAD" };
  let kind = "changed";
  if (blocked.value || files.value.changed.length === 0) kind = "untracked";
  if (named.value.length === 0 && !blocked.value) kind = "unnamed";
  return t(`localChanges.${asked.operation}.${kind}`, params);
});
const shown = computed(() => named.value.slice(0, SHOWN));
const more = computed(() => Math.max(0, named.value.length - SHOWN));
/** What a screen reader hears after the sentence: the files, and what to do with them. */
const described = computed(() => [
  ...(shown.value.length > 0 ? [filesId] : []),
  ...(blocked.value ? [moveId] : []),
]);

/** The confirm's way through, and the other one a switch offers beside it. */
const first = computed<LocalChangesChoice>(() =>
  leaveFirst.value ? "leave" : switching.value ? "carry" : "aside",
);
const second = computed<LocalChangesChoice>(() => (leaveFirst.value ? "carry" : "leave"));

function label(choice: LocalChangesChoice): string {
  if (choice === "carry") return t("localChanges.bring");
  if (choice === "leave") return t("localChanges.leave");
  return t(`localChanges.aside.${question.value?.operation ?? "merge"}`);
}
</script>

<template>
  <Dialog
    v-if="question"
    :title="t('localChanges.title')"
    :body="body"
    :described-by="described"
    :confirm-label="label(first)"
    :cancel-label="blocked ? t('localChanges.close') : ''"
    :no-confirm="blocked"
    :focus-confirm="!blocked"
    data-testid="local-changes-dialog"
    @confirm="() => void localChanges.choose(first)"
    @cancel="localChanges.dismiss()"
  >
    <ul
      v-if="shown.length > 0"
      :id="filesId"
      class="flex flex-col gap-1"
      data-testid="local-changes-files"
    >
      <li v-for="path in shown" :key="path" class="font-mono text-mono-sm break-all text-fg">
        {{ path }}
      </li>
      <li v-if="more > 0" class="text-sm text-fg-muted">
        {{ t("localChanges.more", { n: more }) }}
      </li>
    </ul>
    <p v-if="blocked" :id="moveId" class="text-md text-fg-secondary">
      {{ t("localChanges.moveThem") }}
    </p>
    <div class="flex flex-col gap-2">
      <button
        type="button"
        class="flex items-center gap-1 self-start text-sm text-fg-secondary hover:text-fg"
        :aria-expanded="outputShown"
        :aria-controls="outputId"
        data-testid="local-changes-output-toggle"
        @click="outputShown = !outputShown"
      >
        <component
          :is="outputShown ? ChevronDown : ChevronRight"
          :size="12"
          :stroke-width="1.5"
          aria-hidden="true"
        />
        {{ outputShown ? t("errorBanner.hideGitOutput") : t("errorBanner.showGitOutput") }}
      </button>
      <pre
        v-if="outputShown"
        :id="outputId"
        class="overflow-x-auto font-mono text-mono-sm whitespace-pre text-fg-secondary select-text"
        data-testid="local-changes-output"
        >{{ question.detail }}</pre>
    </div>
    <template v-if="switching" #actions>
      <Button
        size="lg"
        variant="secondary"
        :data-testid="`local-changes-${second}`"
        @click="() => void localChanges.choose(second)"
      >
        {{ label(second) }}
      </Button>
    </template>
  </Dialog>
</template>
