// What needs attention in a project, as Home's rows say it: "2 with changes · 1 behind · 1
// rebasing · 1 missing", the warnings flagged for `--warn`; nothing when it is up to date.

import { useI18n } from "vue-i18n";

import type { Project } from "@/ipc/schemas";
import { attentionOf, useProjectsStore } from "@/stores/projects";

export interface AttentionPart {
  text: string;
  warn: boolean;
}

export function useAttention(): (project: Project) => AttentionPart[] {
  const { t, n } = useI18n();
  const projects = useProjectsStore();

  return (project) => {
    const counts = attentionOf(projects.members(project));
    const parts: AttentionPart[] = [];
    if (counts.changes > 0) {
      parts.push({ text: t("home.projects.changes", { n: n(counts.changes) }), warn: false });
    }
    if (counts.behind > 0) {
      parts.push({ text: t("home.projects.behind", { n: n(counts.behind) }), warn: true });
    }
    for (const [operation, count] of Object.entries(counts.operations)) {
      parts.push({
        text: t(`home.projects.operation.${operation}`, { n: n(count) }),
        warn: true,
      });
    }
    if (counts.missing > 0) {
      parts.push({ text: t("home.projects.missing", { n: n(counts.missing) }), warn: true });
    }
    return parts;
  };
}
