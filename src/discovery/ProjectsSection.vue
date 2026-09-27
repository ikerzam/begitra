<script setup lang="ts">
// Home's projects: above the table while there are any, each with its name, its
// number of repositories and what needs attention ("2 with changes · 1 behind · 1 rebasing"),
// the warnings in `--warn`; ↵ or a click opens its view; "New project…" on the header. One tab
// stop: ↑↓ and j/k move between the projects.

import { ChevronRight, Layers, Plus } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import type { Project } from "@/ipc/schemas";
import { rowStep } from "@/shortcuts/useListNavigation";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { attentionOf, useProjectsStore } from "@/stores/projects";

const { t, n } = useI18n();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();
const list = ref<HTMLElement | null>(null);
/** The project row that takes the Tab stop. */
const focused = ref(0);

/** Each project's line: its parts, the warnings flagged. */
function attention(project: Project): { text: string; warn: boolean }[] {
  const counts = attentionOf(projects.members(project));
  const parts: { text: string; warn: boolean }[] = [];
  if (counts.changes > 0) {
    parts.push({ text: t("home.projects.changes", { n: n(counts.changes) }), warn: false });
  }
  if (counts.behind > 0) {
    parts.push({ text: t("home.projects.behind", { n: n(counts.behind) }), warn: true });
  }
  for (const [operation, count] of Object.entries(counts.operations)) {
    parts.push({ text: t(`home.projects.operation.${operation}`, { n: n(count) }), warn: true });
  }
  if (counts.missing > 0) {
    parts.push({ text: t("home.projects.missing", { n: n(counts.missing) }), warn: true });
  }
  return parts;
}

const rows = computed(() =>
  projects.projects.map((project) => ({ project, attention: attention(project) })),
);

const stop = computed(() => Math.min(focused.value, rows.value.length - 1));

function onKeydown(event: KeyboardEvent, at: number): void {
  const step = rowStep(event);
  if (step === 0) return;
  event.preventDefault();
  const buttons = list.value?.querySelectorAll<HTMLElement>("[data-project]");
  buttons?.[Math.min(Math.max(at + step, 0), rows.value.length - 1)]?.focus();
}
</script>

<template>
  <section
    v-if="projects.projects.length > 0"
    class="project-section flex flex-col px-5 pb-3"
    :aria-label="t('home.projects.title')"
    data-testid="home-projects"
  >
    <div class="flex h-control items-center">
      <h2 class="text-md font-medium text-fg">{{ t("home.projects.title") }}</h2>
      <Button
        class="ml-auto"
        variant="ghost"
        :icon="Plus"
        data-testid="home-new-project"
        @click="dialogs.create()"
      >
        {{ t("project.new.open") }}
      </Button>
    </div>
    <ul ref="list" class="project-list flex flex-col">
      <li v-for="(row, at) in rows" :key="row.project.id">
        <button
          type="button"
          data-project
          :tabindex="at === stop ? 0 : -1"
          class="flex h-row-list w-full items-center gap-3 rounded-sm px-2 text-left text-md hover:bg-hover focus-visible:bg-selected"
          data-testid="home-project"
          @focus="focused = at"
          @click="() => void projects.open(row.project.id, 'overview')"
          @keydown="(event) => onKeydown(event, at)"
        >
          <Layers
            :size="16"
            :stroke-width="1.5"
            class="shrink-0 text-fg-secondary"
            aria-hidden="true"
          />
          <span class="truncate text-fg">{{ row.project.name }}</span>
          <span class="shrink-0 text-sm text-fg-muted">
            {{
              t(
                "project.repositories",
                { n: n(row.project.members.length) },
                row.project.members.length,
              )
            }}
          </span>
          <span
            class="flex min-w-0 items-center gap-2 truncate text-sm"
            data-testid="home-project-attention"
          >
            <template v-if="row.attention.length === 0">
              <span class="text-fg-muted">{{ t("home.projects.upToDate") }}</span>
            </template>
            <template v-for="(part, index) in row.attention" v-else :key="part.text">
              <span v-if="index > 0" class="text-fg-muted">{{ " · " }}</span>
              <span :class="part.warn ? 'text-warn' : 'text-fg-secondary'">{{ part.text }}</span>
            </template>
          </span>
          <ChevronRight
            :size="16"
            :stroke-width="1.5"
            class="ml-auto shrink-0 text-fg-muted"
            aria-hidden="true"
          />
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* The header and the projects sit 2px apart; no spacing step is 2. */
.project-section,
.project-list {
  gap: 2px;
}
</style>
