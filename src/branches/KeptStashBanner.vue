<script setup lang="ts">
// The banner under the top bar while a stash git kept is the user's to settle: the local
// changes came back with conflicts (a carried switch, git's autostash), so the stash still holds
// them. While conflicts remain it says so, with "Resolve…" from another screen; once none
// remains, that the changes are back and the stash still holds a copy, with "Keep it" (the
// banner goes, the stash stays) and, once the stash is listed, "Drop the stash…" (confirmed
// here, the stash list's toast keeping the hash). An operation in progress keeps its own
// banner. A failed resolution shows git's words under it; the focus a button held when the
// banner goes is handed back to the layout.

import { Archive } from "@lucide/vue";
import { computed, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import { useLocalChangesStore } from "@/stores/localChanges";
import { useSequencerStore } from "@/stores/sequencer";
import { useShellStore } from "@/stores/shell";

import SequencerFailure from "./SequencerFailure.vue";

const emit = defineEmits<{
  /** The banner went with the focus on one of its buttons ("Keep it", a drop). */
  released: [];
}>();

const { t, n } = useI18n();
const localChanges = useLocalChangesStore();
const sequencer = useSequencerStore();
const shell = useShellStore();
const banner = useTemplateRef<HTMLElement>("banner");

const conflicts = computed(() => sequencer.conflictCount);
const title = computed(() =>
  conflicts.value > 0
    ? t("localChanges.backTitle", { n: n(conflicts.value) }, conflicts.value)
    : t("localChanges.backResolvedTitle"),
);
const hint = computed(() =>
  conflicts.value > 0 ? t("localChanges.backHint") : t("localChanges.backResolvedHint"),
);
/** What the live region reads: the banner's words while it shows. */
const announced = computed(() => (localChanges.keptShown ? `${title.value}. ${hint.value}` : ""));

// The banner unmounts under the focused button: the shell gives the focus to the layout shown.
let held = false;
watch(
  () => localChanges.keptShown,
  () => {
    held = banner.value?.contains(document.activeElement) ?? false;
  },
  { flush: "pre" },
);
watch(
  () => localChanges.keptShown,
  (shown) => {
    const was = held;
    held = false;
    if (!was || shown) return;
    const active = document.activeElement;
    if (active === null || active === document.body) emit("released");
  },
  { flush: "post" },
);
</script>

<template>
  <!-- Mounted always, so the banner's first words are read as it appears. -->
  <p class="sr-only" aria-live="polite" data-testid="kept-stash-live">{{ announced }}</p>
  <div
    v-if="localChanges.keptShown"
    ref="banner"
    class="flex flex-col border-b border-line bg-raised"
    data-testid="kept-stash-banner"
  >
    <div class="flex h-bar-top items-center gap-3 px-3 whitespace-nowrap">
      <Archive
        :size="16"
        :stroke-width="1.5"
        aria-hidden="true"
        class="shrink-0"
        :class="conflicts > 0 ? 'text-warn' : 'text-fg-secondary'"
      />
      <span class="text-md font-medium text-fg" data-testid="kept-stash-title">{{ title }}</span>
      <span class="min-w-0 truncate text-sm text-fg-muted" data-testid="kept-stash-hint">
        {{ hint }}
      </span>
      <div class="ml-auto flex items-center gap-3">
        <Button
          v-if="conflicts > 0 && shell.layoutMode !== 'changes'"
          variant="ghost"
          data-testid="kept-stash-resolve"
          @click="() => void shell.setLayoutMode('changes')"
        >
          {{ t("sequencer.banner.resolve") }}
        </Button>
        <template v-if="conflicts === 0">
          <Button variant="ghost" data-testid="kept-stash-keep" @click="localChanges.forget()">
            {{ t("localChanges.keepIt") }}
          </Button>
          <Button
            v-if="localChanges.keptRow !== null"
            variant="secondary"
            :disabled="!localChanges.canDrop"
            data-testid="kept-stash-drop"
            @click="localChanges.askDrop()"
          >
            {{ t("localChanges.dropStash") }}
          </Button>
        </template>
      </div>
    </div>
    <SequencerFailure />
  </div>
  <!-- Outside the banner, which the live region already reads. -->
  <Dialog
    v-if="localChanges.keptShown && localChanges.dropAsked && localChanges.keptRow"
    :title="t('stash.dropTitle', { name: localChanges.keptRow.name })"
    :body="t('stash.dropBody')"
    :confirm-label="t('stash.dropConfirm')"
    variant="destructive"
    data-testid="kept-stash-drop-dialog"
    @confirm="() => void localChanges.drop()"
    @cancel="localChanges.dismissDrop()"
  />
</template>
