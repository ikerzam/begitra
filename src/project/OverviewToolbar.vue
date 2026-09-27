<script setup lang="ts">
// The Overview's toolbar: the branch groups and the bulk actions, which name the
// selection's count ("Fetch 3") or act on every row ("Fetch all"); while a bulk operation runs,
// its line ("Pulling 1 of 3 repositories · fast-forward only") and Stop; once it ends, the
// counts (the failed in `--danger`), "Retry failed" and "Done".

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

const { t, n } = useI18n();
const overview = useOverviewStore();
const bulk = useBulkStore();

const selected = computed(() => overview.selection.size);
const idle = computed(() => bulk.kind === null);
const empty = computed(() => overview.rows.length === 0);

function label(action: "fetch" | "pull" | "push"): string {
  return selected.value > 0
    ? t(`project.bulk.${action}Some`, { n: n(selected.value) })
    : t(`project.bulk.${action}All`);
}

/** The running line: the operation's count so far. */
const runLine = computed(() => {
  const kind = bulk.kind ?? "fetch";
  return t(`operations.bulk.${kind}`, {
    done: n(bulk.finishedCount),
    total: n(bulk.acting.length),
  });
});

/** The ended line's parts, the failed ones flagged. */
const ended = computed(() => {
  const kind = bulk.kind ?? "fetch";
  const counts = bulk.summary;
  const parts: { text: string; danger: boolean }[] = [];
  if (counts.done > 0) {
    parts.push({
      text: t(`project.bulk.summary.done.${kind}`, { n: n(counts.done) }),
      danger: false,
    });
  }
  if (counts.upToDate > 0) {
    parts.push({
      text: t("project.bulk.summary.upToDate", { n: n(counts.upToDate) }),
      danger: false,
    });
  }
  if (counts.failed > 0) {
    parts.push({ text: t("project.bulk.summary.failed", { n: n(counts.failed) }), danger: true });
  }
  if (counts.skipped > 0) {
    parts.push({
      text: t("project.bulk.summary.skipped", { n: n(counts.skipped) }),
      danger: false,
    });
  }
  if (counts.stopped > 0) {
    parts.push({
      text: t("project.bulk.summary.stopped", { n: n(counts.stopped) }),
      danger: false,
    });
  }
  return parts;
});
</script>

<template>
  <div
    class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2"
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
        class="flex h-control shrink-0 items-center gap-2 rounded-md border border-line px-2 text-md"
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
        <span :class="part.danger ? 'text-danger' : 'text-fg'">{{ part.text }}</span>
      </template>
    </p>
    <div
      v-if="idle"
      class="flex shrink-0 items-center gap-2"
      role="group"
      :aria-label="t('project.bulk.actions')"
    >
      <Button
        :icon="Download"
        :disabled="empty"
        data-testid="bulk-fetch"
        @click="bulk.ask('fetch')"
      >
        {{ label("fetch") }}
      </Button>
      <Button :icon="ArrowDown" :disabled="empty" data-testid="bulk-pull" @click="bulk.ask('pull')">
        {{ label("pull") }}
      </Button>
      <Button :icon="ArrowUp" :disabled="empty" data-testid="bulk-push" @click="bulk.ask('push')">
        {{ label("push") }}
      </Button>
      <Button
        :icon="GitBranch"
        :disabled="empty"
        data-testid="bulk-switch"
        @click="bulk.ask('switch')"
      >
        {{ t("project.bulk.switchBranch") }}
      </Button>
      <Button
        :icon="GitBranchPlus"
        :disabled="empty"
        data-testid="bulk-create"
        @click="bulk.ask('create')"
      >
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
    <div v-else class="flex shrink-0 items-center gap-2">
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
