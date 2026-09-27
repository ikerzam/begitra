<script setup lang="ts">
// "New project…": a name, a filter and the checklist of the indexed repositories and
// worktrees, and "Add repository…", which picks a folder holding a repository the index does
// not know yet, adds it to the index and checks it. Making a project touches no repository; the
// new project's view shows once it is made.

import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { FolderPlus, Search } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import Input from "@/components/Input.vue";
import { errorText } from "@/shell/errorMessage";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { useToastsStore } from "@/stores/toasts";

import RepositoryChecklist from "./RepositoryChecklist.vue";

const { t, n } = useI18n();
const index = useIndexStore();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();
const toasts = useToastsStore();

const name = ref("");
const query = ref("");
const checked = ref<string[]>([]);
const saving = ref(false);

const trimmed = computed(() => name.value.trim());
const nameValid = computed(() => trimmed.value.length > 0 && trimmed.value.length <= 100);
const disabled = computed(() => saving.value || !nameValid.value || checked.value.length === 0);
const confirmLabel = computed(() =>
  t("project.new.confirm", { n: n(checked.value.length) }, checked.value.length),
);

async function addRepository(): Promise<void> {
  const picked = await pickFolder({ directory: true, multiple: false });
  if (typeof picked !== "string") return;
  const added = await index.add(picked);
  if ("path" in added) {
    if (!checked.value.includes(added.path)) checked.value = [...checked.value, added.path];
    return;
  }
  const text = errorText(added, picked);
  toasts.push({ kind: "error", message: t(text.key, text.params), output: added.detail });
}

async function create(): Promise<void> {
  if (disabled.value) return;
  saving.value = true;
  const project = await projects.create(trimmed.value, checked.value);
  saving.value = false;
  if (!project) return;
  dialogs.close();
  await projects.open(project.id, "overview");
}
</script>

<template>
  <Dialog
    size="lg"
    :title="t('project.new.title')"
    :body="t('project.new.body')"
    :confirm-label="confirmLabel"
    :confirm-disabled="disabled"
    data-testid="new-project-dialog"
    @confirm="() => void create()"
    @cancel="dialogs.close()"
  >
    <label class="form-row grid items-start gap-3 text-md text-fg-secondary">
      <span class="flex h-6 items-center">{{ t("project.new.name") }}</span>
      <Input
        v-model="name"
        class="flex-1"
        size="lg"
        :error="name !== '' && !nameValid ? t('project.new.nameInvalid') : ''"
        data-testid="new-project-name"
        @keydown.enter.prevent="() => void create()"
      />
    </label>
    <label class="form-row grid items-start gap-3 text-md text-fg-secondary">
      <span class="flex h-6 items-center">{{ t("project.new.repositories") }}</span>
      <Input
        v-model="query"
        class="flex-1"
        size="lg"
        :icon="Search"
        :placeholder="t('project.new.filter')"
        data-testid="new-project-filter"
      />
    </label>
    <RepositoryChecklist v-model="checked" :query="query" />
    <template #footer-start>
      <Button
        variant="ghost"
        size="lg"
        :icon="FolderPlus"
        data-testid="new-project-add"
        @click="() => void addRepository()"
      >
        {{ t("project.new.addRepository") }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
/* A form field's label takes 88px, 12px before its field. */
.form-row {
  grid-template-columns: 88px minmax(0, 1fr);
}
</style>
