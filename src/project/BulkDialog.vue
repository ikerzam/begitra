<script setup lang="ts">
// The confirmation of a bulk pull, push, switch or new branch: what it does, the
// repositories it acts on (branch and upstream, how far behind for a pull, how many commits a
// push sends) and the ones it skips with the reason, and, for a switch or a new branch, the
// branch's name, the check running again as it is typed. The button names the count.

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { validName } from "@/branches/names";
import Dialog from "@/components/Dialog.vue";
import Input from "@/components/Input.vue";
import LaneDot from "@/components/LaneDot.vue";
import { useBulkStore } from "@/stores/bulk";
import { useOverviewStore } from "@/stores/overview";

import type { PlanItem } from "./precheck";

const { t, n } = useI18n();
const bulk = useBulkStore();
const overview = useOverviewStore();

const plan = computed(() => bulk.plan);
const kind = computed(() => plan.value?.kind ?? "pull");
const needsName = computed(() => kind.value === "switch" || kind.value === "create");
const name = ref("");
const nameValid = computed(() => validName(name.value.trim()));
const count = computed(() => plan.value?.acting.length ?? 0);

watch(name, (value) => bulk.recheck(value));

const title = computed(() =>
  t(`project.bulk.title.${kind.value}`, { n: n(count.value) }, count.value),
);
const confirmLabel = computed(() => t(`project.bulk.confirm.${kind.value}`, { n: n(count.value) }));
const disabled = computed(() => count.value === 0 || (needsName.value && !nameValid.value));

/** The mono column: where each branch goes. */
function route(item: PlanItem): string {
  const branch = item.branch ?? "HEAD";
  switch (kind.value) {
    case "pull":
      return item.upstream ? `${branch} ← ${item.upstream}` : branch;
    case "push":
      return item.upstream ? `${branch} → ${item.upstream}` : branch;
    default:
      return name.value.trim() ? `${branch} → ${name.value.trim()}` : branch;
  }
}

/** The right column: how far behind for a pull, the commits a push sends. */
function amount(item: PlanItem): string {
  if (kind.value === "pull") {
    const behind = item.behind ?? 0;
    return behind > 0
      ? t("project.bulk.behind", { n: n(behind) })
      : t("project.bulk.upToDateSoFar");
  }
  if (kind.value === "push") {
    const ahead = item.ahead ?? 0;
    return t("project.bulk.commits", { n: n(ahead) }, ahead);
  }
  return "";
}

function lane(item: PlanItem): number {
  return item.branch === null ? 0 : (overview.lanes.get(item.branch) ?? 0);
}

function reason(item: PlanItem): string {
  return t(`project.skip.${item.reason ?? "missing"}`, {
    operation: item.operation ? t(`project.operationWord.${item.operation}`) : "",
    remote: item.remote ?? "",
  });
}

function confirm(): void {
  if (!disabled.value) bulk.confirm();
}
</script>

<template>
  <Dialog
    v-if="plan"
    size="xl"
    :title="title"
    :body="t(`project.bulk.body.${kind}`)"
    :confirm-label="confirmLabel"
    :confirm-disabled="disabled"
    data-testid="bulk-dialog"
    @confirm="confirm"
    @cancel="bulk.cancelPlan()"
  >
    <label v-if="needsName" class="flex items-center gap-4 text-md text-fg-secondary">
      <span class="w-20 shrink-0">{{ t("project.bulk.name") }}</span>
      <Input
        v-model="name"
        class="flex-1"
        size="lg"
        :placeholder="t('project.bulk.namePlaceholder')"
        :error="name.trim() !== '' && !nameValid ? t('project.bulk.nameInvalid') : ''"
        data-testid="bulk-name"
        @keydown.enter.prevent="confirm"
      />
    </label>
    <section v-if="plan.acting.length > 0" class="flex flex-col gap-1">
      <h3 class="text-sm text-fg-muted">{{ t(`project.bulk.acting.${kind}`) }}</h3>
      <ul class="flex flex-col" data-testid="bulk-acting">
        <li
          v-for="item in plan.acting"
          :key="item.path"
          class="bulk-item grid h-row-list items-center gap-3 text-md"
        >
          <LaneDot v-if="lane(item) > 0" :lane="lane(item)" />
          <span v-else aria-hidden="true" />
          <span class="truncate text-fg">{{ item.name }}</span>
          <span class="truncate font-mono text-mono-sm text-fg-secondary">{{ route(item) }}</span>
          <span class="text-right text-sm text-fg-secondary">{{ amount(item) }}</span>
        </li>
      </ul>
    </section>
    <section v-if="plan.skipped.length > 0" class="flex flex-col gap-1">
      <h3 class="text-sm text-fg-muted">{{ t("project.bulk.skipped") }}</h3>
      <ul class="flex flex-col" data-testid="bulk-skipped">
        <li
          v-for="item in plan.skipped"
          :key="item.path"
          class="bulk-item grid h-row-list items-center gap-3 text-md"
        >
          <LaneDot v-if="lane(item) > 0" :lane="lane(item)" />
          <span v-else aria-hidden="true" />
          <span class="truncate text-fg">{{ item.name }}</span>
          <span class="truncate font-mono text-mono-sm text-fg-secondary">
            {{ item.branch ?? "" }}
          </span>
          <span class="truncate text-right text-sm text-warn">{{ reason(item) }}</span>
        </li>
      </ul>
    </section>
    <p v-if="kind === 'pull' || kind === 'push'" class="text-sm text-fg-muted">
      {{ kind === "pull" ? t("project.bulk.countsNote") : t("project.bulk.pushNote") }}
    </p>
  </Dialog>
</template>

<style scoped>
/* Lane dot, name 144, the route, the amount or the reason. */
.bulk-item {
  grid-template-columns: 8px 144px minmax(0, 1fr) auto;
}
</style>
