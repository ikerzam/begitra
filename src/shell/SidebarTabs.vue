<script setup lang="ts">
// The Repos, Branches and Worktrees tabs: a tablist with roving focus where Left and Right
// (and Home and End) move between the tabs and select them.

import { ref } from "vue";
import { useI18n } from "vue-i18n";

import TabsItem from "@/components/TabsItem.vue";
import type { SidebarTab } from "@/stores/shell";

const props = defineProps<{ active: SidebarTab }>();
const emit = defineEmits<{ select: [tab: SidebarTab] }>();

const { t } = useI18n();
const list = ref<HTMLElement | null>(null);

const tabs: { id: SidebarTab; label: string }[] = [
  { id: "repos", label: "sidebar.repos" },
  { id: "branches", label: "sidebar.branches" },
  { id: "worktrees", label: "sidebar.worktrees" },
];

function onKeydown(event: KeyboardEvent): void {
  const current = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === props.active),
  );
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault();
  const tab = tabs[next];
  if (!tab) return;
  emit("select", tab.id);
  list.value?.querySelectorAll<HTMLElement>("[role='tab']")[next]?.focus();
}
</script>

<template>
  <div
    ref="list"
    role="tablist"
    class="flex h-panel-header shrink-0 items-center gap-4 border-b border-line px-3"
    data-testid="sidebar-tabs"
    @keydown="onKeydown"
  >
    <TabsItem
      v-for="tab in tabs"
      :key="tab.id"
      :label="t(tab.label)"
      :selected="props.active === tab.id"
      :controls="`sidebar-${tab.id}`"
      :data-testid="`tab-${tab.id}`"
      @select="emit('select', tab.id)"
    />
  </div>
</template>
