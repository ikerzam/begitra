<script setup lang="ts">
// The members of the edit dialog: 32px rows with the grip, the lane dot (its branch's
// among these members, as the Overview colours them; grey for a missing member), the name, the
// path in mono, "missing", and move up, move down and remove. One tab stop: ↑↓ and j/k move the
// focus, Ctrl ↑ and Ctrl ↓ (⌘ on macOS) move the focused member, Delete removes it; the focus
// stays in the list, on the list itself once it is empty. Ten rows, then the list scrolls.

import { ChevronDown, ChevronUp, GripVertical, X } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import LaneDot from "@/components/LaneDot.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { matchesKeys } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { rowStep } from "@/shortcuts/useListNavigation";
import { branchGroups } from "@/stores/overview";
import type { ProjectMember } from "@/stores/projects";

const props = defineProps<{ members: ProjectMember[] }>();
const emit = defineEmits<{ move: [at: number, step: -1 | 1]; remove: [at: number] }>();

const { t } = useI18n();
const format = useDiscoveryFormat();
const list = ref<HTMLElement | null>(null);
const focused = ref(0);

const stop = computed(() => Math.min(focused.value, props.members.length - 1));

const branchOf = (member: ProjectMember): string | null =>
  member.missing ? null : (member.entry?.summary.currentBranch ?? null);

/** The members' branches as lanes, most common first, as the Overview colours them. */
const lanes = computed(
  () =>
    new Map(branchGroups(props.members.map(branchOf)).map((group) => [group.branch, group.lane])),
);

function lane(member: ProjectMember): number {
  const branch = branchOf(member);
  return branch === null ? 0 : (lanes.value.get(branch) ?? 0);
}

/** Focuses row `at` once the list shows the change, clamped to its rows; the list without any. */
function focusRow(at: number): void {
  void nextTick(() => {
    const rows = Array.from(list.value?.querySelectorAll<HTMLElement>("[data-member]") ?? []);
    if (rows.length === 0) {
      list.value?.focus();
      return;
    }
    focused.value = Math.max(0, Math.min(at, rows.length - 1));
    rows[focused.value]?.focus();
  });
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
    tabindex="-1"
    class="members flex flex-col overflow-y-auto rounded-md border border-line"
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
/* Ten rows, then the list scrolls, so Save stays in the window. */
.members {
  max-height: 320px;
}
</style>
