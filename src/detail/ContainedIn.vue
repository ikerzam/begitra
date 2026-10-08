<script setup lang="ts">
// The summary's last line: the branches, remote branches and tags whose history holds the
// commit, asked for with "Find", since the read walks the whole history. While it reads,
// "Looking…", counting the seconds after two; then the badges, twelve before "+N more", or "No
// branch or tag"; a failure says so, with "Try again", and git's output a click away when git
// said something. The label hangs beside the badges, which wrap under each other. A polite
// live region says each step of the commit on screen once; a button that leaves with its
// press hands the focus to the line rather than to the page.

import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";

import RefBadge from "@/components/RefBadge.vue";
import type { Ref as GitRef } from "@/ipc/schemas";
import { useContainedStore, type Contained } from "@/stores/contained";
import { useRepoStore } from "@/stores/repo";

import { containedBadges } from "./contained";

const props = defineProps<{ commit: string; refs: GitRef[] }>();

/** Badges shown before "+N more": about three lines of a 480px panel. */
const SHOWN = 12;
/** Seconds a read runs before the line counts them. */
const QUIET_SECONDS = 2;

const { t, n } = useI18n();
const contained = useContainedStore();
const repo = useRepoStore();
const labelId = useId();
const outputId = useId();
const root = ref<HTMLElement | null>(null);

const state = computed(() => contained.of(props.commit));
/** The current branch and the main worktree's branch lead, with their upstreams. */
const leading = computed(() => {
  const current = props.refs.find((entry) => entry.kind === "local-branch" && entry.isCurrent);
  const main = repo.worktrees.find((worktree) => worktree.isMain)?.branch ?? null;
  return [current?.name ?? null, main?.replace(/^refs\/heads\//, "") ?? null].filter(
    (name): name is string => name !== null,
  );
});
const badges = computed(() =>
  state.value?.kind === "answered"
    ? containedBadges(state.value.refs, props.refs, leading.value)
    : [],
);
const expanded = ref(false);
const outputShown = ref(false);
const shown = computed(() => (expanded.value ? badges.value : badges.value.slice(0, SHOWN)));
const hidden = computed(() => badges.value.length - shown.value.length);

/** The time of a read, ticking once a second only while it runs. */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
function stopTicking(): void {
  if (ticker !== undefined) clearInterval(ticker);
  ticker = undefined;
}
watch(
  () => state.value?.kind === "reading",
  (reading) => {
    stopTicking();
    now.value = Date.now();
    if (reading) ticker = setInterval(() => (now.value = Date.now()), 1000);
  },
  { immediate: true },
);
onBeforeUnmount(stopTicking);
const looking = computed(() => {
  const current = state.value;
  if (current?.kind !== "reading") return "";
  const seconds = Math.floor((now.value - current.startedAt) / 1000);
  return seconds >= QUIET_SECONDS ? t("detail.lookingFor", { n: seconds }) : t("detail.looking");
});

/** What the live region says of a step: only the transitions of the commit on screen. */
const announced = ref("");
function announcement(step: Contained | null): string {
  switch (step?.kind) {
    case "reading":
      return t("detail.looking");
    case "answered":
      return step.refs.length === 0
        ? t("detail.noRef")
        : t("detail.containedCount", { n: n(step.refs.length) }, step.refs.length);
    case "failed":
      return t("detail.containedFailed");
    default:
      return "";
  }
}
watch(
  () => [props.commit, state.value?.kind] as const,
  ([commit], [before]) => {
    announced.value = commit === before ? announcement(state.value) : "";
    if (commit !== before) outputShown.value = false;
    // Another commit, or a new read of this one: the list folds again.
    expanded.value = false;
  },
);

/** Runs `act`; when the pressed button leaves with it, the line takes the focus. */
async function keepFocus(act: () => void): Promise<void> {
  const held = root.value?.contains(document.activeElement) ?? false;
  act();
  await nextTick();
  const lost = document.activeElement === null || document.activeElement === document.body;
  if (held && lost) root.value?.focus();
}

function find(): void {
  void keepFocus(() => void contained.find(props.commit));
}

function more(): void {
  void keepFocus(() => (expanded.value = true));
}
</script>

<template>
  <div ref="root" tabindex="-1" class="flex flex-col gap-2" data-testid="contained-in">
    <p class="sr-only" aria-live="polite" data-testid="contained-live">{{ announced }}</p>
    <div
      role="group"
      :aria-labelledby="labelId"
      class="flex items-baseline gap-2 text-sm text-fg-secondary"
    >
      <span :id="labelId" class="shrink-0 text-fg-muted">{{ t("detail.containedIn") }}</span>
      <button
        v-if="state === null"
        type="button"
        class="text-link hover:underline"
        data-testid="contained-find"
        @click="find"
      >
        {{ t("detail.find") }}
      </button>
      <span
        v-else-if="state.kind === 'reading'"
        class="text-fg-muted"
        data-testid="contained-reading"
      >
        {{ looking }}
      </span>
      <span
        v-else-if="state.kind === 'answered' && state.refs.length === 0"
        data-testid="contained-none"
      >
        {{ t("detail.noRef") }}
      </span>
      <div v-else-if="state.kind === 'answered'" class="flex min-w-0 flex-wrap items-center gap-1">
        <RefBadge v-for="badge in shown" :key="badge.key" :kind="badge.kind" :label="badge.label" />
        <button
          v-if="hidden > 0"
          type="button"
          class="ml-1 text-link hover:underline"
          data-testid="contained-more"
          @click="more"
        >
          {{ t("detail.moreRefs", { n: n(hidden) }) }}
        </button>
      </div>
      <span v-else class="flex flex-wrap items-baseline gap-2">
        <span class="text-danger">{{ t("detail.containedFailed") }}</span>
        <button
          type="button"
          class="text-link hover:underline"
          data-testid="contained-retry"
          @click="find"
        >
          {{ t("detail.tryAgain") }}
        </button>
        <button
          v-if="state.error.detail"
          type="button"
          class="text-link hover:underline"
          :aria-expanded="outputShown"
          :aria-controls="outputId"
          data-testid="contained-output-toggle"
          @click="outputShown = !outputShown"
        >
          {{ outputShown ? t("errorBanner.hideGitOutput") : t("errorBanner.showGitOutput") }}
        </button>
      </span>
    </div>
    <pre
      v-if="state?.kind === 'failed' && state.error.detail && outputShown"
      :id="outputId"
      class="overflow-x-auto font-mono text-mono-sm whitespace-pre text-fg-secondary select-text"
      data-testid="contained-output"
      >{{ state.error.detail }}</pre>
  </div>
</template>
