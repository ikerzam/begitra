<script setup lang="ts">
// "Add repositories…" of the edit dialog: the checklist of the indexed repositories
// and worktrees that are not members yet, with its filter; "Add N" hands the checked paths
// back in the list's order.

import { Search } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import Input from "@/components/Input.vue";

import RepositoryChecklist from "./RepositoryChecklist.vue";

const props = defineProps<{ exclude: string[] }>();
const emit = defineEmits<{ add: [paths: string[]]; cancel: [] }>();

const { t, n } = useI18n();
const query = ref("");
const checked = ref<string[]>([]);
const confirmLabel = computed(() =>
  t("project.editDialog.addConfirm", { n: n(checked.value.length) }, checked.value.length),
);
</script>

<template>
  <Dialog
    size="lg"
    :title="t('project.editDialog.addTitle')"
    :confirm-label="confirmLabel"
    :confirm-disabled="checked.length === 0"
    data-testid="add-repositories-dialog"
    @confirm="emit('add', checked)"
    @cancel="emit('cancel')"
  >
    <Input
      v-model="query"
      size="lg"
      :icon="Search"
      :placeholder="t('project.new.filter')"
      data-testid="add-repositories-filter"
    />
    <RepositoryChecklist v-model="checked" :query="query" :exclude="props.exclude" />
  </Dialog>
</template>
