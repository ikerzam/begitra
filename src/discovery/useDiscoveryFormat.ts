// The sentences of the home screen: the header count line, the progress line, the state or
// count of a scan folder, relative dates and abbreviated paths. Components only render.

import { computed, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";

import { abbreviateHome, relativeDate, type RelativeDate } from "@/shell/format";
import { useHomeDir } from "@/shell/useHomeDir";
import { useNow } from "@/shell/useNow";
import { useIndexStore } from "@/stores/index";

export interface DiscoveryFormat {
  /** "14 repositories and 3 worktrees in 2 folders. Last scan 2 minutes ago." */
  summary: ComputedRef<string>;
  /** "312 folders scanned, 14 repositories found" */
  progressLine: ComputedRef<string>;
  /** The state of a folder while scanning, its flag, or its counts. */
  folderStatus: (folder: string) => string;
  /** Whether `folderStatus` names a failure (rendered in the danger colour). */
  folderFailed: (folder: string) => boolean;
  /** "2h ago" for a commit time; empty when unknown. */
  shortAgo: (unixSeconds: number | null) => string;
  /** "~/code/geoportal" when the home folder is known. */
  displayPath: (path: string) => string;
}

export function useDiscoveryFormat(): DiscoveryFormat {
  const { t } = useI18n();
  const index = useIndexStore();
  const now = useNow();
  const home = useHomeDir();

  const summary = computed(() => {
    const scan = index.scan;
    if (scan.kind === "scanning") {
      return t("home.scanningFolders", Object.keys(scan.folders).length);
    }
    const { repositories, worktrees, folders } = index.counts;
    const parts = {
      repositories: t("home.repositories", repositories),
      worktrees: t("home.worktrees", worktrees),
      folders: t("home.folders", folders),
    };
    const sentences = [
      worktrees > 0 ? t("home.summaryWithWorktrees", parts) : t("home.summary", parts),
    ];
    const failed = index.failedFolders.length;
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

  function folderFailed(folder: string): boolean {
    const scan = index.scan;
    if (scan.kind === "scanning" && scan.folders[folder] !== undefined) {
      return scan.folders[folder] === "error";
    }
    return index.folderErrors[folder] !== undefined;
  }

  function folderStatus(folder: string): string {
    const scan = index.scan;
    const state = scan.kind === "scanning" ? scan.folders[folder] : undefined;
    if (state === "queued") return t("home.folderState.queued");
    if (state === "scanning") return t("home.folderState.scanning");
    if (state === "error" || (state === undefined && folderFailed(folder))) {
      return t("home.folderState.notFound");
    }
    const { repositories, worktrees } = index.folderCounts(folder);
    const parts: string[] = [];
    if (repositories > 0) parts.push(t("home.repositories", repositories));
    if (worktrees > 0) parts.push(t("home.worktrees", worktrees));
    return parts.length > 0 ? parts.join(", ") : t("home.folderState.empty");
  }

  function displayPath(path: string): string {
    return abbreviateHome(path, home.value);
  }

  return { summary, progressLine, folderStatus, folderFailed, shortAgo, displayPath };
}
