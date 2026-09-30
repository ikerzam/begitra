// The sentences of Home: the header's count line, the progress line, a project's count or the
// state of its folder's scan, relative dates and abbreviated paths. Components only render.

import { computed, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";

import type { Project } from "@/ipc/schemas";
import { abbreviateHome, relativeDate, sameFolder, type RelativeDate } from "@/shell/format";
import { useHomeDir } from "@/shell/useHomeDir";
import { useNow } from "@/shell/useNow";
import { useIndexStore, type FolderScanState } from "@/stores/index";
import { useProjectsStore } from "@/stores/projects";

export interface DiscoveryFormat {
  /** "3 projects, 14 repositories and 3 worktrees. Last scan 2 minutes ago." */
  summary: ComputedRef<string>;
  /** "312 folders scanned, 14 repositories found" */
  progressLine: ComputedRef<string>;
  /** What the running scan does with a folder: queued, scanning, or nothing. */
  folderState: (folder: string) => FolderScanState | undefined;
  /** A project's count, "3 so far" while its folder's scan walks it, or "not found". */
  projectStatus: (project: Project) => string;
  /** Whether the last scans could not read a folder (rendered in the danger colour). */
  folderFailed: (folder: string) => boolean;
  /** "2h ago" for a commit time; empty when unknown. */
  shortAgo: (unixSeconds: number | null) => string;
  /** "~/code/geoportal" when the home folder is known. */
  displayPath: (path: string) => string;
}

export function useDiscoveryFormat(): DiscoveryFormat {
  const { t } = useI18n();
  const index = useIndexStore();
  const projects = useProjectsStore();
  const now = useNow();
  const home = useHomeDir();

  const summary = computed(() => {
    const scan = index.scan;
    if (scan.kind === "scanning") {
      return t("home.scanningFolders", Object.keys(scan.folders).length);
    }
    if (!index.loaded || !projects.loaded) return t("home.loading");
    const { repositories, worktrees } = index.counts;
    const parts = {
      projects: t("home.projectCount", projects.projects.length),
      repositories: t("home.repositories", repositories),
      worktrees: t("home.worktrees", worktrees),
    };
    const sentences = [
      worktrees > 0 ? t("home.summaryWithWorktrees", parts) : t("home.summary", parts),
    ];
    const failed = projects.folders.filter((folder) => folderFailed(folder)).length;
    if (failed > 0) {
      sentences.push(t("home.foldersFailed", failed));
    } else if (index.lastScanAt !== null) {
      sentences.push(
        t("home.lastScan", { ago: longAgo(relativeDate(index.lastScanAt, now.value)) }),
      );
    }
    return sentences.join(" ");
  });

  const progressLine = computed(() => {
    const scan = index.scan;
    if (scan.kind !== "scanning") return "";
    return `${t("home.foldersScanned", scan.scanned)}, ${t("home.repositoriesFound", scan.found)}`;
  });

  function longAgo(ago: RelativeDate): string {
    return ago.unit === "now" ? t("dateLong.now") : t(`dateLong.${ago.unit}`, ago.n);
  }

  function shortAgo(unixSeconds: number | null): string {
    if (unixSeconds === null) return "";
    const ago = relativeDate(unixSeconds, now.value);
    return ago.unit === "now" ? t("date.now") : t(`date.${ago.unit}`, { n: ago.n });
  }

  function folderState(folder: string): FolderScanState | undefined {
    const scan = index.scan;
    if (scan.kind !== "scanning") return undefined;
    return Object.entries(scan.folders).find(([known]) => sameFolder(known, folder))?.[1];
  }

  function folderFailed(folder: string): boolean {
    const state = folderState(folder);
    if (state !== undefined) return state === "error";
    return Object.keys(index.folderErrors).some((known) => sameFolder(known, folder));
  }

  function projectStatus(project: Project): string {
    const folder = project.folder;
    if (folder === null) return t("project.repositories", project.members.length);
    const state = folderState(folder);
    const { repositories, worktrees } = projects.folderCounts(project);
    if (state === "queued") return t("home.folderState.queued");
    if (state === "scanning")
      return t("home.folderState.scanning", { n: repositories + worktrees });
    if (folderFailed(folder)) return t("home.folderState.notFound");
    const parts: string[] = [];
    const hand = project.members.length - repositories - worktrees;
    if (repositories + hand > 0) parts.push(t("home.repositories", repositories + hand));
    if (worktrees > 0) parts.push(t("home.worktrees", worktrees));
    return parts.length > 0 ? parts.join(", ") : t("home.folderState.empty");
  }

  function displayPath(path: string): string {
    return abbreviateHome(path, home.value);
  }

  return {
    summary,
    progressLine,
    folderState,
    projectStatus,
    folderFailed,
    shortAgo,
    displayPath,
  };
}
