// "Open on <forge>", "Copy link" and "Reveal in Explorer" for the menus: the link a commit, a
// ref or a file has, through the remote the rules pick (forgeLinks), and the three actions with
// their toasts. A file of the working tree links at the current branch's upstream, without a
// line, since its lines are not the upstream's. The backend checks the link and the path again
// before it opens anything.

import { useI18n } from "vue-i18n";

import { remoteOf } from "@/branches/names";
import * as ipc from "@/ipc/commands";
import { toAppError } from "@/ipc/errors";
import type { Ref, Remote } from "@/ipc/schemas";
import { goneUpstream } from "@/shell/branchMarkers";
import { copyText } from "@/shell/clipboard";
import { sameFolder } from "@/shell/format";
import { detectPlatform } from "@/shortcuts/platform";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useToastsStore } from "@/stores/toasts";

import { linkedPath, type FileFacts, type FileSource } from "./fileLinks";
import { forgeNames, forgeOf, linkTo, remoteFor, type LinkTarget } from "./forgeLinks";

/** What a menu asks a link for. */
export type LinkSubject =
  | { kind: "commit"; hash: string }
  | { kind: "ref"; ref: Ref }
  /** A file at a commit, at `line` when given, or of the working tree (`commit` null). */
  | { kind: "file"; path: string; commit: string | null; line?: number | null };

/** A link a menu offers. */
export interface Link {
  url: string;
  /** The forge's name, for "Open on <forge>". */
  forge: string;
}

export function useLinks() {
  const { t } = useI18n();
  const repo = useRepoStore();
  const remotes = useRemotesStore();
  const toasts = useToastsStore();

  /** The remotes a link needs; a menu asks for them as it opens, quietly. */
  function ensureRemotes(): void {
    if (!remotes.loaded && !remotes.loading) void remotes.load({ quiet: true });
  }

  /** The toast of a link or a path the backend refused: one the app never builds. */
  function refused(): void {
    toasts.push({ kind: "error", message: t("errors.externalRefused") });
  }

  function through(remote: Remote | null | undefined, target: LinkTarget): Link | null {
    const forge = remote ? forgeOf(remote.fetchUrl) : null;
    return forge ? { url: linkTo(forge, target), forge: forgeNames[forge.kind] } : null;
  }

  /** The remote and the name there of a local branch's upstream; null without one or gone. */
  function upstreamOf(branch: Ref | null): { remote: Remote; name: string } | null {
    if (!branch || branch.upstream === null || goneUpstream(branch) !== null) return null;
    const tracked = remoteOf({ kind: "remote-branch", name: branch.upstream }, remotes.remotes);
    const remote = remotes.remotes.find((entry) => entry.name === tracked?.remote);
    return tracked && remote ? { remote, name: tracked.branch } : null;
  }

  /** The remote a commit's, a tag's or a file's link goes through. */
  function defaultRemote(): Remote | null {
    return remoteFor(repo.currentBranch?.upstream ?? null, remotes.remotes);
  }

  function refLink(ref: Ref): Link | null {
    switch (ref.kind) {
      case "local-branch": {
        const upstream = upstreamOf(ref);
        return upstream && through(upstream.remote, { kind: "branch", name: upstream.name });
      }
      case "remote-branch": {
        const tracked = remoteOf(ref, remotes.remotes);
        const remote = remotes.remotes.find((entry) => entry.name === tracked?.remote);
        return tracked ? through(remote, { kind: "branch", name: tracked.branch }) : null;
      }
      case "tag":
        return through(defaultRemote(), { kind: "tag", name: ref.name });
      default:
        return null;
    }
  }

  /** The link of `subject`; null when the repository has no remote on a forge Begitra knows. */
  function linkOf(subject: LinkSubject): Link | null {
    switch (subject.kind) {
      case "commit":
        return through(defaultRemote(), { kind: "commit", hash: subject.hash });
      case "ref":
        return refLink(subject.ref);
      case "file": {
        if (subject.commit !== null) {
          const at = { kind: "commit", hash: subject.commit } as const;
          const line = subject.line ?? null;
          return through(defaultRemote(), { kind: "file", path: subject.path, at, line });
        }
        const upstream = upstreamOf(repo.currentBranch ?? null);
        if (!upstream) return null;
        const at = { kind: "branch", name: upstream.name } as const;
        return through(upstream.remote, { kind: "file", path: subject.path, at, line: null });
      }
    }
  }

  /**
   * The link of `file` at `source`, at `line` for a commit's file; null when none applies. A
   * file of another repository's working tree (a project's Changes) has none: the app reads
   * the remotes of the open repository only.
   */
  function fileLink(
    file: FileFacts,
    source: FileSource | null,
    line: number | null = null,
  ): Link | null {
    if (source === null) return null;
    const path = linkedPath(file, source);
    if (path === null) return null;
    if (source.kind === "commit") return linkOf({ kind: "file", path, commit: source.hash, line });
    const open = repo.repo?.root;
    if (!open || !sameFolder(open, source.root)) return null;
    return linkOf({ kind: "file", path, commit: null });
  }

  async function open(link: Link): Promise<void> {
    try {
      await ipc.openLink(link.url);
    } catch (error) {
      const failure = toAppError(error);
      if (failure.code === "external.refused") {
        refused();
        return;
      }
      toasts.push({
        kind: "error",
        message: t("links.openFailed"),
        action: t("errorBanner.showOutput"),
        output: failure.detail ?? failure.message,
      });
    }
  }

  async function copy(link: Link): Promise<void> {
    if (await copyText(link.url)) {
      toasts.push({ kind: "success", message: t("links.copied") });
    } else {
      toasts.push({ kind: "error", message: t("graph.clipboardUnavailable") });
    }
  }

  /** "Reveal in Explorer", "Reveal in Finder" or "Open containing folder". */
  const revealLabel = t(`links.reveal.${detectPlatform()}`);

  /**
   * Shows `path`, of the working tree at `root` or one of its worktrees, in the file manager;
   * `shown` names it in a toast (a file's repository-relative path).
   */
  async function reveal(root: string, path: string, shown = path): Promise<void> {
    try {
      await ipc.revealPath(root, path);
    } catch (error) {
      const failure = toAppError(error);
      if (failure.code === "external.not_found") {
        toasts.push({ kind: "error", message: t("errors.notOnDisk", { path: shown }) });
        return;
      }
      if (failure.code === "external.refused") {
        refused();
        return;
      }
      toasts.push({
        kind: "error",
        message: t("links.revealFailed"),
        action: t("errorBanner.showOutput"),
        output: failure.detail ?? failure.message,
      });
    }
  }

  return { ensureRemotes, linkOf, fileLink, open, copy, revealLabel, reveal };
}
