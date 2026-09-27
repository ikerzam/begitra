<script setup lang="ts">
// "Edit project…": the name, the members in the Overview's order (`EditMembersList`:
// moved with their buttons or Ctrl ↑ and Ctrl ↓, removed with their button or Delete), "Add
// repositories…" from the index, and "Delete project…", which confirms once and says no
// repository is touched. Nothing is written until Save.

import { Plus, Trash2 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import Input from "@/components/Input.vue";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { resolveMembers, useProjectsStore } from "@/stores/projects";

import AddRepositoriesDialog from "./AddRepositoriesDialog.vue";
import EditMembersList from "./EditMembersList.vue";

const props = defineProps<{ id: number }>();

const { t } = useI18n();
const projects = useProjectsStore();
const index = useIndexStore();
const dialogs = useProjectDialogsStore();

const project = computed(() => projects.find(props.id) ?? null);
const name = ref(project.value?.name ?? "");
const paths = ref<string[]>([...(project.value?.members ?? [])]);
const adding = ref(false);
const deleting = ref(false);

const members = computed(() =>
  resolveMembers(
    { id: props.id, name: name.value, members: paths.value, createdAt: 0, updatedAt: 0 },
    index.entries,
  ),
);
const trimmed = computed(() => name.value.trim());
const nameValid = computed(() => trimmed.value.length > 0 && trimmed.value.length <= 100);
const changed = computed(
  () =>
    trimmed.value !== project.value?.name ||
    paths.value.join("\n") !== (project.value?.members ?? []).join("\n"),
);
/** The keys that move and remove a row, as this platform writes them ("Ctrl ↑", "⌘↑", "⌫"). */
const moveKeys = computed(() => {
  const platform = shortcutRegistry().platform;
  return {
    up: formatShortcut("mod+arrowup", platform),
    down: formatShortcut("mod+arrowdown", platform),
    remove: formatShortcut(platform === "macos" ? "backspace" : "delete", platform),
  };
});

function move(at: number, step: -1 | 1): void {
  const to = at + step;
  if (to < 0 || to >= paths.value.length) return;
  const next = [...paths.value];
  const [moved] = next.splice(at, 1);
  if (moved === undefined) return;
  next.splice(to, 0, moved);
  paths.value = next;
}

function remove(at: number): void {
  paths.value = paths.value.filter((_, known) => known !== at);
}

function add(added: string[]): void {
  paths.value = [...paths.value, ...added.filter((path) => !paths.value.includes(path))];
  adding.value = false;
}

async function save(): Promise<void> {
  const current = project.value;
  if (!current || !nameValid.value) return;
  if (trimmed.value !== current.name) await projects.rename(current.id, trimmed.value);
  if (paths.value.join("\n") !== current.members.join("\n")) {
    await projects.setMembers(current.id, paths.value);
  }
  dialogs.close();
}

async function confirmDelete(): Promise<void> {
  deleting.value = false;
  if (await projects.remove(props.id)) dialogs.close();
}
</script>

<template>
  <Dialog
    v-if="project && !adding && !deleting"
    size="lg"
    :title="t('project.editDialog.title')"
    :confirm-label="t('project.editDialog.save')"
    :confirm-disabled="!nameValid || !changed"
    data-testid="edit-project-dialog"
    @confirm="() => void save()"
    @cancel="dialogs.close()"
  >
    <label class="form-row grid items-center gap-4 text-md text-fg-secondary">
      <span>{{ t("project.new.name") }}</span>
      <Input
        v-model="name"
        size="lg"
        :error="!nameValid ? t('project.new.nameInvalid') : ''"
        data-testid="edit-project-name"
      />
    </label>
    <div class="flex items-center gap-2 text-md">
      <span class="text-fg-secondary">{{ t("project.new.repositories") }}</span>
      <span class="text-sm text-fg-muted">{{ t("project.editDialog.order") }}</span>
      <Button
        class="ml-auto"
        variant="ghost"
        :icon="Plus"
        data-testid="edit-project-add"
        @click="adding = true"
      >
        {{ t("project.editDialog.add") }}
      </Button>
    </div>
    <EditMembersList :members="members" @move="move" @remove="remove" />
    <p class="text-sm text-fg-muted">{{ t("project.editDialog.hint", moveKeys) }}</p>
    <template #footer-start>
      <Button
        variant="ghost-danger"
        size="lg"
        :icon="Trash2"
        data-testid="edit-project-delete"
        @click="deleting = true"
      >
        {{ t("project.editDialog.delete") }}
      </Button>
    </template>
  </Dialog>
  <AddRepositoriesDialog v-if="adding" :exclude="paths" @add="add" @cancel="adding = false" />
  <Dialog
    v-if="deleting && project"
    variant="destructive"
    :title="t('project.editDialog.deleteTitle', { name: project.name })"
    :body="t('project.editDialog.deleteBody')"
    :confirm-label="t('project.editDialog.deleteConfirm')"
    data-testid="delete-project-dialog"
    @confirm="() => void confirmDelete()"
    @cancel="deleting = false"
  />
</template>

<style scoped>
/* A form field's label takes 96px. */
.form-row {
  grid-template-columns: 96px minmax(0, 1fr);
}
</style>
