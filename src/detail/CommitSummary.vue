<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import RefBadge from "@/components/RefBadge.vue";
import { commitBadges, refsByName } from "@/graph/badges";
import type { CommitNode, Ref as GitRef } from "@/ipc/schemas";
import { absoluteDate, relativeDate, shortHash } from "@/shell/format";
import { useNow } from "@/shell/useNow";

const props = defineProps<{ commit: CommitNode; refs: GitRef[] }>();
const emit = defineEmits<{ selectParent: [hash: string] }>();

const { t, locale } = useI18n();

const now = useNow();
const relative = computed(() => {
  const rel = relativeDate(props.commit.author.time, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
});
const absolute = computed(() => absoluteDate(props.commit.author.time, locale.value));

const badges = computed(() => commitBadges(props.commit.refs, refsByName(props.refs)));
</script>

<template>
  <div class="flex flex-col gap-2 px-3 py-3" data-testid="commit-summary">
    <h3 class="text-lg font-medium text-fg" data-testid="commit-subject">
      {{ props.commit.subject }}
    </h3>
    <p
      v-if="props.commit.body"
      class="text-md whitespace-pre-wrap text-fg-secondary"
      data-testid="commit-body"
    >
      {{ props.commit.body }}
    </p>
    <p class="flex flex-wrap items-center gap-4 text-sm text-fg-secondary">
      <span class="text-fg">{{ props.commit.author.name }}</span>
      <span>{{ relative }}</span>
      <span class="text-fg-muted">{{ absolute }}</span>
    </p>
    <p
      v-if="props.commit.parents.length > 0"
      class="flex items-center gap-2 text-sm text-fg-secondary"
    >
      <span>{{ props.commit.parents.length > 1 ? t("detail.parents") : t("detail.parent") }}</span>
      <button
        v-for="parent in props.commit.parents"
        :key="parent"
        type="button"
        class="font-mono text-mono-sm text-link hover:underline"
        data-testid="parent-link"
        @click="emit('selectParent', parent)"
      >
        {{ shortHash(parent) }}
      </button>
    </p>
    <div v-if="badges.length > 0" class="flex flex-wrap items-center gap-2">
      <RefBadge v-for="badge in badges" :key="badge.key" :kind="badge.kind" :label="badge.label" />
    </div>
  </div>
</template>
