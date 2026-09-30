<script setup lang="ts">
// The graph's repository selector: the app's select naming the
// repository the open project shows and listing the project's repositories in its order, each
// worktree under its repository, a missing one flagged and not choosable; choosing one shows
// its graph and makes it the one the project shows. The filter bar shows it while the project
// holds more than one repository.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import { useProjectsStore } from "@/stores/projects";

const { t } = useI18n();
const projects = useProjectsStore();

const options = computed<SelectOption[]>(() =>
  projects.activeMembers.map((member) => ({
    value: member.path,
    label: member.name,
    nested: member.nested,
    disabled: member.missing,
    hint: member.missing ? t("sidebar.notFound") : undefined,
  })),
);

const value = computed({
  get: () => projects.activeMembers.find((member) => projects.isShown(member.path))?.path ?? "",
  set: (path: string) => {
    if (!projects.isShown(path)) void projects.show(path);
  },
});
</script>

<template>
  <div class="graph-repository">
    <Select
      v-model="value"
      :options="options"
      :label="t('graph.repository')"
      data-testid="filter-repository"
    />
  </div>
</template>

<style scoped>
/* 160px holds a repository's name and the chevron; the list grows to its longest name. It
   gives way with the search when the bar is short of room (FilterBar's weights). */
.graph-repository {
  flex-shrink: 20;
  width: 160px;
  min-width: 96px;
}
</style>
