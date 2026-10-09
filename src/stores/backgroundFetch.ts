// The open project's repositories fetched in the background on the interval its "Fetch" field
// sets: every remote of each repository once the interval has passed since it last fetched (the
// latest `FETCH_HEAD` of the project's members of it, or its last try here), the worktrees of a
// repository riding on its fetch, two at a time, never prompting, with no toast and no status
// bar line. Nothing starts while the window is hidden, the system reports no network, a fetch,
// pull or push by hand or a project's bulk operation runs, or the open project has no interval.
// A command by hand on a repository fetching in the background waits for that fetch (`idle`). A
// remote that asks for a sign-in stops its repository, with one toast, until a fetch by hand
// there works; any other failure waits for the next interval, or, when the network was gone,
// for the system to report it back.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { StreamHandle } from "@/ipc/stream";
import { classifyFailure } from "@/project/failures";
import { baseName, sameFolder } from "@/shell/format";

import { useBulkStore } from "./bulk";
import { useFolderStore } from "./folder";
import { useIndexStore } from "./index";
import { useProjectsStore } from "./projects";
import { useRemotesStore } from "./remotes";
import { useRepoStore } from "./repo";
import { useSettingsStore, type FetchInterval } from "./settings";
import { useToastsStore } from "./toasts";

/** Repositories fetching in the background at once: nobody waits for them, and a project's
 * repositories usually share a host. */
const AT_ONCE = 2;
/** How often the schedule looks for a repository whose interval has passed. */
export const TICK_MS = 60_000;

/** A repository of the open project with the worktrees of it the project holds: one fetch. */
interface Family {
  /** The repository's path, or its first worktree's when the project does not hold it. */
  leader: string;
  members: string[];
  /** Unix seconds of the latest fetch of any of them; null before any. */
  fetchedAt: number | null;
}

export const useBackgroundFetchStore = defineStore("backgroundFetch", () => {
  const settings = useSettingsStore();
  const projects = useProjectsStore();
  const index = useIndexStore();
  const repo = useRepoStore();
  const toasts = useToastsStore();

  /** The fetches running, by family (the repository's path). */
  const running = new Map<string, { handle: StreamHandle; done: Promise<void> }>();
  /** How many run. */
  const runningCount = ref(0);
  /** The families stopped for a sign-in. */
  const stopped = ref<ReadonlySet<string>>(new Set());
  /** When each family was last tried in this session, in milliseconds. */
  const tried = new Map<string, number>();
  /** The families whose last try found no network: tried again once the system is online. */
  const unreachable = new Set<string>();
  /** The families whose stop a toast has said in this session. */
  const told = new Set<string>();

  /** Project `id`'s interval in minutes; null when it is fetched by hand only. */
  function intervalOf(id: number): FetchInterval | null {
    return settings.values.backgroundFetch[String(id)] ?? null;
  }

  /** Sets project `id`'s interval; null fetches it by hand only. The schedule reads it at once,
   * the settings file a moment later. */
  function setIntervalOf(id: number, minutes: FetchInterval | null): void {
    const next = { ...settings.values.backgroundFetch };
    if (minutes === null) delete next[String(id)];
    else next[String(id)] = minutes;
    void settings.update("backgroundFetch", next);
  }

  /** The open project's interval. */
  const interval = computed(() => (projects.active ? intervalOf(projects.active.id) : null));

  /** The family `path` belongs to: its repository's path. */
  function familyOf(path: string): string {
    return index.lookup(path)?.parentPath ?? path;
  }

  /** The open project's families, its missing members left out. */
  function families(): Map<string, Family> {
    const found = new Map<string, Family>();
    for (const member of projects.activeMembers) {
      const entry = member.entry;
      if (member.missing || !entry) continue;
      const key = entry.parentPath ?? entry.path;
      const fetchedAt = entry.summary.fetchedAt;
      const known = found.get(key);
      if (!known) {
        found.set(key, { leader: entry.path, members: [entry.path], fetchedAt });
        continue;
      }
      known.members.push(entry.path);
      if (entry.path === key) known.leader = entry.path;
      if (fetchedAt !== null && (known.fetchedAt === null || fetchedAt > known.fetchedAt)) {
        known.fetchedAt = fetchedAt;
      }
    }
    return found;
  }

  /** Starts the families of the open project whose interval has passed, up to two running. */
  function tick(): void {
    const minutes = interval.value;
    if (minutes === null || document.hidden || !navigator.onLine) return;
    if (useRemotesStore().inFlight !== null || useBulkStore().running) return;
    const now = Date.now();
    for (const [key, family] of families()) {
      if (running.size >= AT_ONCE) return;
      if (running.has(key) || stopped.value.has(key)) continue;
      const last = Math.max((family.fetchedAt ?? 0) * 1000, tried.get(key) ?? 0);
      if (now - last >= minutes * 60_000) start(key, family);
    }
  }

  function start(key: string, family: Family): void {
    tried.set(key, Date.now());
    unreachable.delete(key);
    const handle = ipc.fetch(
      family.leader,
      null,
      false,
      () => undefined,
      newOpId("background-fetch"),
      true,
    );
    // What a command by hand waits for: git's fetch and, with "Move main forward" on, the main
    // branch's move, both writes of the repository's refs.
    const done = handle.done.then(
      () => followMain(family.leader),
      (failure: unknown) => failed(key, family, failure),
    );
    running.set(key, { handle, done });
    runningCount.value = running.size;
    void done.then(() => {
      running.delete(key);
      runningCount.value = running.size;
      void readAgain(family);
      tick();
    });
  }

  /** With "Move main forward" on, the main branch follows quietly, as after a bulk fetch. */
  async function followMain(leader: string): Promise<void> {
    if (!settings.values.moveMainAfterFetch) return;
    await ipc.mainFastForward(leader, newOpId("background-main")).catch(() => null);
  }

  function failed(key: string, family: Family, failure: unknown): void {
    const error = toAppError(failure);
    if (error.code === "op.cancelled") return;
    const reason = classifyFailure(error).reason;
    if (reason === "network") unreachable.add(key);
    if (reason !== "sign-in") return;
    stopped.value = new Set([...stopped.value, key]);
    if (told.has(key)) return;
    told.add(key);
    toasts.push({
      kind: "info",
      message: "",
      key: "backgroundFetch.signIn",
      params: { name: index.lookup(family.leader)?.name ?? baseName(family.leader) },
      slot: "background-fetch",
    });
  }

  /** The members' rows and, for the open repository, its refs read again; the engine the
   * fetch opened goes unless the open repository or the folder view holds it. */
  async function readAgain(family: Family): Promise<void> {
    const open = repo.repo?.root ?? null;
    const isOpen = (path: string) => open !== null && sameFolder(path, open);
    if (family.members.some(isOpen)) void repo.refreshRefs();
    if (!isOpen(family.leader) && !useFolderStore().shown) {
      void ipc.closeRepository(family.leader).catch(() => undefined);
    }
    await Promise.all(family.members.map((path) => index.refresh(path, false)));
  }

  /** Unix seconds of the latest fetch of `path`'s repository or of a worktree of it the index
   * knows (each worktree keeps its own `FETCH_HEAD`, and they share the remote-tracking refs);
   * null before any. */
  function lastFetchOf(path: string): number | null {
    const key = familyOf(path);
    let latest: number | null = null;
    for (const entry of index.entries) {
      if ((entry.parentPath ?? entry.path) !== key) continue;
      const at = entry.summary.fetchedAt;
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }

  /** The fetch in the background running on `path`'s repository, as what settles once it has
   * ended; null when none runs. */
  function idle(path: string): Promise<void> | null {
    return running.get(familyOf(path))?.done ?? null;
  }

  /** Cancels the fetch in the background on `path`'s repository: git's process tree ends. */
  async function cancel(path: string): Promise<void> {
    await running.get(familyOf(path))?.handle.cancel();
  }

  /** A fetch by hand worked on `path`'s repository: a stop for a sign-in ends there. */
  function resume(path: string): void {
    const key = familyOf(path);
    if (!stopped.value.has(key)) return;
    const next = new Set(stopped.value);
    next.delete(key);
    stopped.value = next;
  }

  /** Whether `path`'s repository stopped fetching in the background for a sign-in. */
  function stoppedFor(path: string): boolean {
    return stopped.value.has(familyOf(path));
  }

  /** The intervals of projects that are gone leave the settings. */
  function prune(ids: readonly number[]): void {
    const stored = settings.values.backgroundFetch;
    const kept = Object.fromEntries(
      Object.entries(stored).filter(([key]) => ids.includes(Number(key))),
    );
    if (Object.keys(kept).length !== Object.keys(stored).length) {
      void settings.update("backgroundFetch", kept);
    }
  }

  /**
   * Runs the schedule: a tick every minute, and one at once when the open project or its
   * interval changes, the index is read, the window shows again, or the system is back online
   * (then the families that found no network are due again). Answers what stops it.
   */
  function begin(): () => void {
    const timer = window.setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    const onOnline = () => {
      for (const key of unreachable) tried.delete(key);
      unreachable.clear();
      tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    const stopTicks = watch(
      () => [projects.active?.id ?? null, interval.value, index.read] as const,
      () => tick(),
      { immediate: true },
    );
    const stopPrune = watch(
      () => (projects.loaded ? projects.projects.map((project) => project.id).join(",") : null),
      () => {
        if (projects.loaded) prune(projects.projects.map((project) => project.id));
      },
      { immediate: true },
    );
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      stopTicks();
      stopPrune();
    };
  }

  return {
    runningCount,
    stopped,
    interval,
    intervalOf,
    setIntervalOf,
    tick,
    idle,
    cancel,
    resume,
    stoppedFor,
    lastFetchOf,
    begin,
  };
});
