<script setup lang="ts">
// The members of the edit dialog: 32px rows with the grip, the lane dot (grey for a
// missing member), the name, the path in mono, "missing", and move up, move down and remove.
// One tab stop: ↑↓ and j/k move the focus, Ctrl ↑ and Ctrl ↓ (⌘ on macOS) move the focused
// member, Delete removes it.

import { ChevronDown, ChevronUp, GripVertical, X } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import LaneDot from "@/components/LaneDot.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { matchesKeys } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { rowStep } from "@/shortcuts/useListNavigation";
import { useOverviewStore } from "@/stores/overview";
import type { ProjectMember } from "@/stores/projects";

const props = defineProps<{ members: ProjectMember[] }>();
const emit = defineEmits<{ move: [at: number, step: -1 | 1]; remove: [at: number] }>();

const { t } = useI18n();
const overview = useOverviewStore();
const format = useDiscoveryFormat();
const list = ref<HTMLElement | null>(null);
const focused = ref(0);

const stop = computed(() => Math.min(focused.value, props.members.length - 1));

function lane(member: ProjectMember): number {
  const branch = member.entry?.summary.currentBranch;
  return branch ? (overview.lanes.get(branch) ?? 0) : 0;
}

function focusRow(at: number): void {
  focused.value = Math.max(0, Math.min(at, props.members.length - 1));
  void nextTick(() =>
    list.value?.querySelectorAll<HTMLElement>("[data-member]")[focused.value]?.focus(),
  );
}

function onKeydown(event: KeyboardEvent, at: number): void {
  if (event.target !== event.currentTarget) return;
  const platform = shortcutRegistry().platform;
  if (matchesKeys("mod+arrowup", event, platform)) {
    event.preventDefault();
    emit("move", at, -1);
    focusRow(at - 1);
  } else if (matchesKeys("mod+arrowdown", event, platform)) {
    event.preventDefault();
    emit("move", at, 1);
    focusRow(at + 1);
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    emit("remove", at);
    focusRow(at);
  } else {
    const step = rowStep(event);
    if (step === 0) return;
    event.preventDefault();
    focusRow(at + step);
  }
}
</script>

<template>
  <ul
    ref="list"
    class="flex flex-col overflow-y-auto rounded-md border border-line"
    :aria-label="t('project.new.repositories')"
    data-testid="edit-project-members"
  >
    <li
      v-for="(member, at) in props.members"
      :key="member.path"
      data-member
      :tabindex="at === stop ? 0 : -1"
      class="edit-member grid h-panel-header items-center gap-2 border-b border-line px-2 text-md last:border-b-0 focus-visible:bg-selected"
      @focus="focused = at"
      @keydown="(event) => onKeydown(event, at)"
    >
      <GripVertical :size="14" :stroke-width="1.5" class="text-fg-muted" aria-hidden="true" />
      <LaneDot v-if="lane(member) > 0" :lane="lane(member)" />
      <span
        v-else
        class="inline-block size-2 shrink-0 rounded-full bg-fg-disabled"
        aria-hidden="true"
      />
      <span class="truncate" :class="member.missing ? 'text-fg-muted' : 'text-fg'">
        {{ member.name }}
      </span>
      <span class="truncate font-mono text-mono-sm text-fg-muted">
        {{ format.displayPath(member.path) }}
      </span>
      <span class="text-sm text-warn">
        {{ member.missing ? t("project.editDialog.missing") : "" }}
      </span>
      <IconButton
        :label="t('project.editDialog.moveUp', { name: member.name })"
        :icon="ChevronUp"
        :disabled="at === 0"
        tabindex="-1"
        @click="emit('move', at, -1)"
      />
      <IconButton
        :label="t('project.editDialog.moveDown', { name: member.name })"
        :icon="ChevronDown"
        :disabled="at === props.members.length - 1"
        tabindex="-1"
        @click="emit('move', at, 1)"
      />
      <IconButton
        :label="t('project.editDialog.remove', { name: member.name })"
        :icon="X"
        tabindex="-1"
        data-testid="edit-project-remove"
        @click="emit('remove', at)"
      />
    </li>
    <li v-if="props.members.length === 0" class="px-3 py-2 text-sm text-fg-muted">
      {{ t("project.editDialog.none") }}
    </li>
  </ul>
</template>

<style scoped>
/* Grip 14, lane dot, name 130, path, missing, move up, move down, remove. */
.edit-member {
  grid-template-columns: 14px 8px 130px minmax(0, 1fr) auto 24px 24px 24px;
}
.edit-member:focus-visible {
  outline: none;
}
</style>
