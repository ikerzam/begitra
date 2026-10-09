<script setup lang="ts">
// "Edit project…": the name; how often the project fetches in the background
// (`FetchIntervalField`); for a folder project, its folder's own repositories
// (`OwnMembersList`), which its scans keep and no edit moves or removes; the members added by
// hand in their order
// (`EditMembersList`: moved with their buttons or Ctrl ↑ and Ctrl ↓, removed with their button
// or Delete); "Add repositories…" from the index; the ones the edit takes out of Begitra (they
// belong to no other project), named before Save; and "Delete project…", which asks in its own
// confirmation. Nothing is written until Save, and nothing is written to a repository.

import { Plus, Trash2 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import Input from "@/components/Input.vue";
import { sameFolder } from "@/shell/format";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useBackgroundFetchStore } from "@/stores/backgroundFetch";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { resolveMembers, useProjectsStore } from "@/stores/projects";

import AddRepositoriesDialog from "./AddRepositoriesDialog.vue";
import EditMembersList from "./EditMembersList.vue";
import FetchIntervalField from "./FetchIntervalField.vue";
import LeavingList from "./LeavingList.vue";
import OwnMembersList from "./OwnMembersList.vue";

const props = defineProps<{ id: number }>();

const { t } = useI18n();
const projects = useProjectsStore();
const index = useIndexStore();
const dialogs = useProjectDialogsStore();
const background = useBackgroundFetchStore();

const project = computed(() => projects.find(props.id) ?? null);
const handOf = () =>
  (project.value?.members ?? []).filter((m) => m.origin === "hand").map((m) => m.path);
const name = ref(project.value?.name ?? "");
const interval = ref(background.intervalOf(props.id));
/** The members added by hand, as edited. */
const paths = ref<string[]>(handOf());
const adding = ref(false);
const saving = ref(false);

/** The project as a folder project, for its own repositories; null for a list project. */
const folderProject = computed(() => {
  const current = project.value;
  return current && current.folder !== null ? { ...current, folder: current.folder } : null;
});
const members = computed(() =>
  resolveMembers(
    { folder: null, members: paths.value.map((path) => ({ path, origin: "hand" as const })) },
    index.entries,
    index.read,
    false,
  ),
);
/** The members the edit takes out that no other project holds: they leave Begitra on Save. */
const leaving = computed(() => {
  const current = project.value;
  if (!current) return [];
  const removed = handOf().filter((path) => !paths.value.some((kept) => sameFolder(kept, path)));
  const gone = projects.leaving(current, removed);
  return resolveMembers(
    { folder: null, members: gone.map((path) => ({ path, origin: "hand" as const })) },
    index.entries,
    index.read,
    false,
  );
});
const trimmed = computed(() => name.value.trim());
const nameValid = computed(() => trimmed.value.length > 0 && trimmed.value.length <= 100);
const reordered = computed(() => paths.value.join("\n") !== handOf().join("\n"));
const changed = computed(
  () =>
    trimmed.value !== project.value?.name ||
    reordered.value ||
    interval.value !== background.intervalOf(props.id),
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

/** Writes the changes; a refused write keeps the dialog and its edits (its toast says why). */
async function save(): Promise<void> {
  const current = project.value;
  if (!current || !nameValid.value || saving.value) return;
  saving.value = true;
  try {
    if (trimmed.value !== current.name && !(await projects.rename(current.id, trimmed.value))) {
      return;
    }
    if (reordered.value && !(await projects.setMembers(current.id, paths.value))) return;
    if (interval.value !== background.intervalOf(current.id)) {
      background.setIntervalOf(current.id, interval.value);
    }
    dialogs.close();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog
    v-if="project && !adding"
    size="lg"
    :title="t('project.editDialog.title')"
    :confirm-label="t('project.editDialog.save')"
    :confirm-disabled="saving || !nameValid || !changed"
    data-testid="edit-project-dialog"
    @confirm="() => void save()"
    @cancel="dialogs.close()"
  >
    <label class="form-row grid items-start gap-3 text-md text-fg-secondary">
      <span class="flex h-6 items-center">{{ t("project.new.name") }}</span>
      <Input
        v-model="name"
        size="lg"
        :error="!nameValid ? t('project.new.nameInvalid') : ''"
        data-testid="edit-project-name"
      />
    </label>
    <FetchIntervalField v-model="interval" />
    <OwnMembersList v-if="folderProject" :project="folderProject" />
    <div class="flex items-center gap-2 text-md">
      <span class="text-fg-secondary">
        {{
          project.folder !== null ? t("project.editDialog.byHand") : t("project.new.repositories")
        }}
      </span>
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
    <template v-if="leaving.length > 0">
      <p class="text-md text-warn" data-testid="edit-project-leaving">
        {{ t("project.editDialog.leaving", leaving.length) }}
      </p>
      <LeavingList :members="leaving" />
    </template>
    <template #footer-start>
      <Button
        variant="ghost-danger"
        size="lg"
        :icon="Trash2"
        data-testid="edit-project-delete"
        @click="dialogs.askDelete(props.id)"
      >
        {{ t("project.editDialog.delete") }}
      </Button>
    </template>
  </Dialog>
  <AddRepositoriesDialog
    v-if="adding && project"
    :exclude="[...project.members.map((member) => member.path), ...paths]"
    @add="add"
    @cancel="adding = false"
  />
</template>

<style scoped>
/* A form field's label takes 88px, 12px before its field. */
.form-row {
  grid-template-columns: 88px minmax(0, 1fr);
}
</style>
