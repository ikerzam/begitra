// The forge pages of commits, branches, tags and files ("Open on GitHub", "Copy link"): a
// remote's fetch URL names the forge by its host and the repository by its path, and each
// forge spells its pages its own way. The backend opens only these forges' hosts
// (src-tauri/src/links.rs keeps the same list).

import { remoteOf } from "@/branches/names";
import type { Ref } from "@/ipc/schemas";

export type ForgeKind = "github" | "gitlab" | "bitbucket" | "azure" | "codeberg" | "gitea";

/** A repository on a forge. */
export interface Forge {
  kind: ForgeKind;
  /** The repository's page, each segment encoded: `https://github.com/geo/portal`. */
  base: string;
}

/** The forges' names, as they spell them. */
export const forgeNames: Record<ForgeKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
  codeberg: "Codeberg",
  gitea: "Gitea",
};

/** Where a file's page shows it: at a commit, or on a branch as the remote names it. */
export type FileAt = { kind: "commit"; hash: string } | { kind: "branch"; name: string };

/** What a link points at; a branch by its name on the remote. */
export type LinkTarget =
  | { kind: "commit"; hash: string }
  | { kind: "branch"; name: string }
  | { kind: "tag"; name: string }
  | { kind: "file"; path: string; at: FileAt; line: number | null };

/**
 * The forges whose repositories sit at `/<owner>/<name>` (GitLab's below any groups), by the
 * hosts their remotes use (the SSH ones over port 443 included), with the host of their pages.
 */
const HOSTS = new Map<string, { kind: Exclude<ForgeKind, "azure">; host: string }>([
  ["github.com", { kind: "github", host: "github.com" }],
  ["ssh.github.com", { kind: "github", host: "github.com" }],
  ["gitlab.com", { kind: "gitlab", host: "gitlab.com" }],
  ["altssh.gitlab.com", { kind: "gitlab", host: "gitlab.com" }],
  ["bitbucket.org", { kind: "bitbucket", host: "bitbucket.org" }],
  ["altssh.bitbucket.org", { kind: "bitbucket", host: "bitbucket.org" }],
  ["codeberg.org", { kind: "codeberg", host: "codeberg.org" }],
  ["gitea.com", { kind: "gitea", host: "gitea.com" }],
]);

/** The hosts the pages are on: the backend opens these alone (an IPC contract test holds them alike). */
export const forgePageHosts: readonly string[] = [
  ...new Set([...HOSTS.values()].map((forge) => forge.host)),
  "dev.azure.com",
];

/** The protocols a remote's URL may name, and those whose port must be the default one. */
const PROTOCOLS = new Set(["https", "http", "ssh", "git", "git+ssh", "ssh+git"]);
const WEB = new Set(["https", "http"]);

const URL_FORM = /^([a-z][a-z0-9+.-]*):\/\//i;
/** `[user@]host:path`, git's scp-like form. */
const SCP_FORM = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
/** An Azure DevOps organisation's own host: `geo.visualstudio.com`. */
const AZURE_ORGANISATION = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/;
const LABEL = /^[a-z0-9][a-z0-9-]*$/i;

interface Location {
  /** In lower case. */
  host: string;
  /** The path's segments, decoded, empty ones dropped. */
  path: string[];
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The host and path a remote's URL names; null for a local path or another protocol. */
function locate(url: string): Location | null {
  const trimmed = url.trim();
  const scheme = URL_FORM.exec(trimmed);
  if (scheme) {
    const protocol = (scheme[1] ?? "").toLowerCase();
    if (!PROTOCOLS.has(protocol)) return null;
    let parsed: URL;
    try {
      // Read as https, whose host the parser lowers and whose default port it drops.
      parsed = new URL(`https://${trimmed.slice(scheme[0].length)}`);
    } catch {
      return null;
    }
    if (WEB.has(protocol) && parsed.port !== "") return null;
    const path = parsed.pathname.split("/").filter((part) => part !== "");
    return { host: parsed.hostname, path: path.map(decoded) };
  }
  const scp = SCP_FORM.exec(trimmed);
  if (!scp) return null;
  const path = (scp[2] ?? "").split("/").filter((part) => part !== "");
  return { host: (scp[1] ?? "").toLowerCase(), path };
}

function encodedPath(parts: readonly string[]): string {
  return parts.map(encodeURIComponent).join("/");
}

/** The repository on Azure DevOps a location names: `…/{organisation}/{project}/_git/{repo}`. */
function azureOf({ host, path }: Location): Forge | null {
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    const [version, organisation, project, repository] = path;
    if (path.length !== 4 || version !== "v3" || !organisation || !project || !repository) {
      return null;
    }
    if (host === "ssh.dev.azure.com") {
      return {
        kind: "azure",
        base: `https://dev.azure.com/${encodedPath([organisation, project, "_git", repository])}`,
      };
    }
    if (!LABEL.test(organisation)) return null;
    return {
      kind: "azure",
      base: `https://${organisation.toLowerCase()}.visualstudio.com/${encodedPath([project, "_git", repository])}`,
    };
  }
  const own = AZURE_ORGANISATION.exec(host) !== null;
  if (host !== "dev.azure.com" && !own) return null;
  const at = path.indexOf("_git");
  // On dev.azure.com the organisation comes first; its own host names it already.
  if (at !== path.length - 2 || at < (own ? 0 : 1)) return null;
  return { kind: "azure", base: `https://${host}/${encodedPath(path)}` };
}

/** The forge and repository a remote's fetch URL names; null for a host Begitra does not know. */
export function forgeOf(url: string): Forge | null {
  const location = locate(url);
  if (!location) return null;
  const azure = azureOf(location);
  if (azure) return azure;
  const forge = HOSTS.get(location.host);
  if (!forge) return null;
  const path = [...location.path];
  const last = path.at(-1);
  if (last?.endsWith(".git")) path[path.length - 1] = last.slice(0, -".git".length);
  if (path.some((part) => part === "" || part === "-")) return null;
  if (forge.kind === "gitlab" ? path.length < 2 : path.length !== 2) return null;
  return { kind: forge.kind, base: `https://${forge.host}/${encodedPath(path)}` };
}

/** `name` (a branch, a tag, a path) encoded a segment at a time, its slashes kept. */
function segments(name: string): string {
  return encodedPath(name.split("/"));
}

/** A file's page on Azure DevOps, which names the file and the version in its query. */
function azureFile(base: string, path: string, at: FileAt, line: number | null): string {
  const version = at.kind === "commit" ? `GC${at.hash}` : `GB${encodeURIComponent(at.name)}`;
  // A whole line selected, as the forge's own "copy link" spells it.
  const lines =
    line === null
      ? ""
      : `&line=${line}&lineEnd=${line + 1}&lineStartColumn=1&lineEndColumn=1&lineStyle=plain`;
  return `${base}?path=/${segments(path)}&version=${version}${lines}&_a=contents`;
}

/** The page of `target` on `forge`. */
export function linkTo(forge: Forge, target: LinkTarget): string {
  const { base } = forge;
  if (forge.kind === "azure") {
    switch (target.kind) {
      case "commit":
        return `${base}/commit/${target.hash}`;
      case "branch":
        return `${base}?version=GB${encodeURIComponent(target.name)}`;
      case "tag":
        return `${base}?version=GT${encodeURIComponent(target.name)}`;
      case "file":
        return azureFile(base, target.path, target.at, target.line);
    }
  }
  if (target.kind === "file") {
    const { at, line } = target;
    const path = segments(target.path);
    const revision = at.kind === "commit" ? at.hash : segments(at.name);
    switch (forge.kind) {
      case "github":
        // The plain view: a rendered file (Markdown) has no line anchors.
        return `${base}/blob/${revision}/${path}${line === null ? "" : `?plain=1#L${line}`}`;
      case "gitlab":
        return `${base}/-/blob/${revision}/${path}${line === null ? "" : `?plain=1#L${line}`}`;
      case "bitbucket":
        return `${base}/src/${revision}/${path}${line === null ? "" : `#lines-${line}`}`;
      case "codeberg":
      case "gitea": {
        const where = at.kind === "commit" ? "commit" : "branch";
        const anchor = line === null ? "" : `?display=source#L${line}`;
        return `${base}/src/${where}/${revision}/${path}${anchor}`;
      }
    }
  }
  if (target.kind === "commit") {
    switch (forge.kind) {
      case "gitlab":
        return `${base}/-/commit/${target.hash}`;
      case "bitbucket":
        return `${base}/commits/${target.hash}`;
      default:
        return `${base}/commit/${target.hash}`;
    }
  }
  const name = segments(target.name);
  switch (forge.kind) {
    case "github":
      return `${base}/tree/${name}`;
    case "gitlab":
      return `${base}/-/tree/${name}`;
    case "bitbucket":
      return target.kind === "branch" ? `${base}/branch/${name}` : `${base}/src/${name}`;
    case "codeberg":
    case "gitea":
      return `${base}/src/${target.kind}/${name}`;
  }
}

/**
 * The remote a link goes through: the one `upstream` (`origin/main`) is on, else `origin`,
 * else the only remote; null when none is.
 */
export function remoteFor<T extends { name: string }>(
  upstream: string | null,
  remotes: readonly T[],
): T | null {
  if (upstream !== null) {
    const tracked = remoteOf({ kind: "remote-branch", name: upstream }, remotes);
    const remote = tracked && remotes.find((entry) => entry.name === tracked.remote);
    if (remote) return remote;
  }
  return (
    remotes.find((entry) => entry.name === "origin") ??
    (remotes.length === 1 ? remotes[0] : undefined) ??
    null
  );
}

const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** The order git reads a short name in: a tag first, then a branch, then a remote branch. */
const SHORT_NAME_ORDER = ["tag", "local-branch", "remote-branch"] as const;

/**
 * The commit `revision` names, from the refs listed: a full hash, `HEAD`, or a ref's full or
 * short name; null for anything else (a short hash names no commit for certain).
 */
export function commitOfRevision(
  revision: string,
  refs: readonly Pick<Ref, "kind" | "name" | "fullName" | "target">[],
): string | null {
  if (FULL_HASH.test(revision)) return revision.toLowerCase();
  if (revision === "HEAD") return refs.find((entry) => entry.kind === "head")?.target ?? null;
  const full = refs.find((entry) => entry.fullName === revision);
  if (full) return full.target;
  for (const kind of SHORT_NAME_ORDER) {
    const ref = refs.find((entry) => entry.kind === kind && entry.name === revision);
    if (ref) return ref.target;
  }
  return null;
}
