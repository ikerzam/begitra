<script setup lang="ts">
// The Overview's toolbar: the branch groups and the bulk actions, which name the
// selection's count ("Fetch 3") or act on every row ("Fetch all"); while a bulk operation runs,
// its line ("Pulling 1 of 3 repositories · fast-forward only") and Stop; once it ends, the
// counts (what went well in `--text`, the failed in `--danger`, the rest muted), "Retry
// failed" and "Done". An empty or failed Overview shows no actions.

import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  GitBranch,
  GitBranchPlus,
  RotateCcw,
  Square,
} from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import LaneDot from "@/components/LaneDot.vue";
import { useBulkStore } from "@/stores/bulk";
import { useOverviewStore } from "@/stores/overview";

const props = withDefaults(defineProps<{ actions?: boolean }>(), { actions: true });

const { t, n } = useI18n();
const overview = useOverviewStore();
const bulk = useBulkStore();

const selected = computed(() => overview.selection.size);
const idle = computed(() => bulk.kind === null);

function label(action: "fetch" | "pull" | "push"): string {
  return selected.value > 0
    ? t(`project.bulk.${action}Some`, { n: n(selected.value) })
    : t(`project.bulk.${action}All`);
}

/** The running line: the operation's count so far. */
const runLine = computed(() =>
  t(`operations.bulk.${bulk.kind ?? "fetch"}`, {
    done: n(bulk.finishedCount),
    total: n(bulk.acting.length),
  }),
);

type Tone = "fg" | "muted" | "danger";
const tones: Record<Tone, string> = {
  fg: "text-fg",
  muted: "text-fg-muted",
  danger: "text-danger",
};

/** The ended line's parts with their tones. */
const ended = computed(() => {
  const kind = bulk.kind ?? "fetch";
  const counts = bulk.summary;
  const parts: { text: string; tone: Tone }[] = [];
  const add = (count: number, key: string, tone: Tone) => {
    if (count > 0) parts.push({ text: t(key, { n: n(count) }), tone });
  };
  add(counts.done, `project.bulk.summary.done.${kind}`, "fg");
  add(counts.upToDate, "project.bulk.summary.upToDate", "muted");
  add(counts.failed, "project.bulk.summary.failed", "danger");
  add(counts.skipped, "project.bulk.summary.skipped", "muted");
  add(counts.stopped, "project.bulk.summary.stopped", "muted");
  return parts;
});
</script>

<template>
  <div
    class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2"
    data-testid="overview-toolbar"
  >
    <ul
      v-if="idle"
      class="flex min-h-control min-w-0 flex-1 items-center gap-2 overflow-hidden"
      :aria-label="t('project.groups')"
    >
      <li
        v-for="group in overview.groups"
        :key="group.branch"
        class="branch-chip flex shrink-0 items-center gap-2 rounded-full border border-line-strong px-2 text-md"
        data-testid="branch-group"
      >
        <LaneDot :lane="group.lane" />
        <span class="text-fg">{{ group.branch }}</span>
        <span class="text-fg-muted">
          {{ t("project.groupCount", { n: n(group.count), total: n(overview.rows.length) }) }}
        </span>
      </li>
    </ul>
    <p
      v-else-if="bulk.running"
      class="flex min-h-control min-w-0 flex-1 items-center gap-2 text-md"
      role="status"
      data-testid="bulk-running"
    >
      <span class="text-fg">{{ runLine }}</span>
      <span v-if="bulk.kind === 'pull'" class="text-fg-muted">
        {{ t("project.bulk.fastForwardOnly") }}
      </span>
    </p>
    <p
      v-else
      class="flex min-h-control min-w-0 flex-1 items-center gap-2 text-md"
      role="status"
      data-testid="bulk-summary"
    >
      <template v-for="(part, at) in ended" :key="part.text">
        <span v-if="at > 0" class="text-fg-muted">{{ " · " }}</span>
        <span :class="tones[part.tone]">{{ part.text }}</span>
      </template>
    </p>
    <div
      v-if="idle && props.actions"
      class="flex shrink-0 items-center gap-2"
      role="group"
      :aria-label="t('project.bulk.actions')"
    >
      <Button :icon="Download" data-testid="bulk-fetch" @click="bulk.ask('fetch')">
        {{ label("fetch") }}
      </Button>
      <Button :icon="ArrowDown" data-testid="bulk-pull" @click="bulk.ask('pull')">
        {{ label("pull") }}
      </Button>
      <Button :icon="ArrowUp" data-testid="bulk-push" @click="bulk.ask('push')">
        {{ label("push") }}
      </Button>
      <Button :icon="GitBranch" data-testid="bulk-switch" @click="bulk.ask('switch')">
        {{ t("project.bulk.switchBranch") }}
      </Button>
      <Button :icon="GitBranchPlus" data-testid="bulk-create" @click="bulk.ask('create')">
        {{ t("project.bulk.newBranch") }}
      </Button>
    </div>
    <Button
      v-else-if="bulk.running"
      :icon="Square"
      data-testid="bulk-stop"
      @click="() => void bulk.stop()"
    >
      {{ t("project.bulk.stop") }}
    </Button>
    <div v-else-if="!idle" class="flex shrink-0 items-center gap-2">
      <Button
        v-if="bulk.failedPaths.length > 0"
        :icon="RotateCcw"
        data-testid="bulk-retry"
        @click="bulk.retryFailed()"
      >
        {{ t("project.bulk.retryFailed") }}
      </Button>
      <Button variant="ghost" :icon="Check" data-testid="bulk-done" @click="bulk.dismiss()">
        {{ t("project.bulk.done") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* The branch groups are 22px pills; no height step is 22. */
.branch-chip {
  height: 22px;
}
</style>
