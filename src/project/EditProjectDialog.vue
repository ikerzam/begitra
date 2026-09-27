<script setup lang="ts">
// "Edit project…": the name, the members in the Overview's order (each with its lane
// dot, name, path, a missing one flagged), moved up and down with their buttons or Ctrl ↑ and
// Ctrl ↓ (⌘ on macOS), removed, and "Add repositories…" from the index; "Delete project…"
// confirms once and says no repository is touched. Nothing is written until Save.

import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, X } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import LaneDot from "@/components/LaneDot.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { formatShortcut, matchesKeys } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useOverviewStore } from "@/stores/overview";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { resolveMembers, useProjectsStore } from "@/stores/projects";
import { useIndexStore } from "@/stores/index";

import AddRepositoriesDialog from "./AddRepositoriesDialog.vue";

const props = defineProps<{ id: number }>();

const { t } = useI18n();
const projects = useProjectsStore();
const index = useIndexStore();
const overview = useOverviewStore();
const dialogs = useProjectDialogsStore();
const format = useDiscoveryFormat();

const project = computed(() => projects.find(props.id) ?? null);
const name = ref(project.value?.name ?? "");
const paths = ref<string[]>([...(project.value?.members ?? [])]);
const adding = ref(false);
const deleting = ref(false);
const list = ref<HTMLElement | null>(null);

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

/** The keys that move a row, as this platform writes them ("Ctrl ↑", "⌘↑"). */
const moveKeys = computed(() => {
  const platform = shortcutRegistry().platform;
  return {
    up: formatShortcut("mod+arrowup", platform),
    down: formatShortcut("mod+arrowdown", platform),
  };
});

function lane(branch: string | null | undefined): number {
  return branch ? (overview.lanes.get(branch) ?? 0) : 0;
}

function move(at: number, step: -1 | 1): void {
  const to = at + step;
  if (to < 0 || to >= paths.value.length) return;
  const next = [...paths.value];
  const [moved] = next.splice(at, 1);
  if (moved === undefined) return;
  next.splice(to, 0, moved);
  paths.value = next;
  void nextTick(() => list.value?.querySelectorAll<HTMLElement>("[data-member]")[to]?.focus());
}

function remove(at: number): void {
  paths.value = paths.value.filter((_, known) => known !== at);
}

function onRowKeydown(event: KeyboardEvent, at: number): void {
  const platform = shortcutRegistry().platform;
  if (matchesKeys("mod+arrowup", event, platform)) {
    event.preventDefault();
    move(at, -1);
  } else if (matchesKeys("mod+arrowdown", event, platform)) {
    event.preventDefault();
    move(at, 1);
  }
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
    <label class="flex items-center gap-4 text-md text-fg-secondary">
      <span class="w-24 shrink-0">{{ t("project.new.name") }}</span>
      <Input
        v-model="name"
        class="flex-1"
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
    <ul
      ref="list"
      class="flex flex-col overflow-y-auto rounded-md border border-line"
      data-testid="edit-project-members"
    >
      <li
        v-for="(member, at) in members"
        :key="member.path"
        data-member
        tabindex="0"
        class="edit-member grid h-row-list items-center gap-2 border-b border-line px-3 text-md last:border-b-0 focus-visible:bg-selected"
        @keydown="(event) => onRowKeydown(event, at)"
      >
        <GripVertical :size="16" :stroke-width="1.5" class="text-fg-muted" aria-hidden="true" />
        <LaneDot
          v-if="lane(member.entry?.summary.currentBranch) > 0"
          :lane="lane(member.entry?.summary.currentBranch)"
        />
        <span v-else aria-hidden="true" />
        <span class="truncate" :class="member.missing ? 'text-fg-muted' : 'text-fg'">
          {{ member.name }}
        </span>
        <span class="truncate font-mono text-mono-sm text-fg-muted">
          {{ format.displayPath(member.path) }}
        </span>
        <span class="text-sm text-warn">{{
          member.missing ? t("project.editDialog.missing") : ""
        }}</span>
        <IconButton
          :label="t('project.editDialog.moveUp', { name: member.name })"
          :icon="ArrowUp"
          :disabled="at === 0"
          tabindex="-1"
          @click="move(at, -1)"
        />
        <IconButton
          :label="t('project.editDialog.moveDown', { name: member.name })"
          :icon="ArrowDown"
          :disabled="at === members.length - 1"
          tabindex="-1"
          @click="move(at, 1)"
        />
        <IconButton
          :label="t('project.editDialog.remove', { name: member.name })"
          :icon="X"
          tabindex="-1"
          data-testid="edit-project-remove"
          @click="remove(at)"
        />
      </li>
      <li v-if="members.length === 0" class="px-3 py-2 text-sm text-fg-muted">
        {{ t("project.editDialog.none") }}
      </li>
    </ul>
    <p class="text-sm text-fg-muted">{{ t("project.editDialog.hint", moveKeys) }}</p>
    <template #footer-start>
      <Button
        variant="ghost"
        size="lg"
        class="text-danger"
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
/* Grip, lane dot, name 160, path, missing, move up, move down, remove. */
.edit-member {
  grid-template-columns: 16px 8px 160px minmax(0, 1fr) auto 24px 24px 24px;
}
.edit-member:focus-visible {
  outline: none;
}
</style>
