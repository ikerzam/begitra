// A bulk operation over the members of the project view: the check before a write,
// then the run, at most four at a time and a repository and its worktrees never at once (they
// share refs), a fetch once per repository, each member with its own op id and Channel as the
// single-repository commands have, git never prompting. Each row keeps its state; Stop cancels
// the fetches, pulls and pushes that have not finished and the queued ones never start; the end
// leaves a summary and "Retry failed", which runs the sign-in failures one at a time with
// prompts allowed. After each member, its summary and lists are read again, and the reads close
// its engine unless it is the open repository or the one the selection is in.

import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { NetworkEvent } from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";
import { classifyFailure } from "@/project/failures";
import { precheck, type BulkPlan, type PlanItem } from "@/project/precheck";
import type { BulkKind, DoneOutcome, MemberRun } from "@/project/run";
import { sameFolder } from "@/shell/format";

import { useFolderStore } from "./folder";
import { useOperationsStore } from "./operations";
import { useOverviewStore } from "./overview";
import { useRepoStore } from "./repo";

/** Members that run at once, all hosts together: members usually share one host. */
export const BULK_AT_ONCE = 4;

/** One member's turn in the run. */
interface Job {
  path: string;
  /** Its repository's root: a repository and its worktrees never run at once. */
  family: string;
  /** Prompts allowed: a sign-in failure retried alone. */
  prompts: boolean;
  /** Members that wait for this fetch and read "fetched with" its name. */
  riders: string[];
}

/** The sign-in retries run one at a time, whatever their repositories. */
const SIGN_IN_LANE = "\u0000sign-in";

/** The last percentage of a progress line (`Receiving objects:  45% (90/200)`). */
export function progressOf(line: string): number | null {
  const all = [...line.matchAll(/(\d{1,3})%/g)];
  const last = all.at(-1)?.[1];
  return last === undefined ? null : Math.min(100, Number(last));
}

export const useBulkStore = defineStore("bulk", () => {
  const overview = useOverviewStore();
  const folder = useFolderStore();
  const operations = useOperationsStore();

  /** The check awaiting its confirmation (pull, push, switch, new branch). */
  const plan = ref<BulkPlan | null>(null);
  /** The run's kind; null when no run shows. */
  const kind = ref<BulkKind | null>(null);
  /** The branch the run switches to or creates. */
  const branch = ref<string | null>(null);
  const states = reactive(new Map<string, MemberRun>());
  /** Whether members are still running or queued. */
  const running = ref(false);

  const queue: Job[] = [];
  const families = new Set<string>();
  const handles = new Map<string, StreamHandle>();
  let inFlight = 0;
  let opId: string | null = null;

  const names = computed(() => new Map(overview.rows.map((row) => [row.path, row.name])));
  const nameOf = (path: string) => names.value.get(path) ?? path;

  /** The members the run acts on: all but the skipped. */
  const acting = computed(() =>
    [...states.entries()].filter(([, state]) => state.state !== "skipped"),
  );
  const finishedCount = computed(
    () =>
      acting.value.filter(([, state]) => state.state !== "queued" && state.state !== "running")
        .length,
  );

  /** The summary line's counts. */
  const summary = computed(() => {
    const counts = { done: 0, upToDate: 0, failed: 0, skipped: 0, stopped: 0 };
    for (const state of states.values()) {
      if (state.state === "done") {
        if (state.outcome === "up-to-date") counts.upToDate += 1;
        else counts.done += 1;
      } else if (state.state === "failed") counts.failed += 1;
      else if (state.state === "skipped") counts.skipped += 1;
      else if (state.state === "stopped") counts.stopped += 1;
    }
    return counts;
  });
  const failedPaths = computed(() =>
    [...states.entries()].filter(([, state]) => state.state === "failed").map(([path]) => path),
  );

  function familyOf(path: string): string {
    const row = overview.rows.find((candidate) => candidate.path === path);
    return row?.mainPath ?? path;
  }

  /**
   * Checks the selection (every row without one) for `next`; a fetch starts at once. Nothing
   * happens while there is no row (the rows not known yet).
   */
  function ask(next: BulkKind, target: string | null = null): void {
    if (overview.targets.length === 0) return;
    const checked = precheck(next, overview.targets, target);
    if (next === "fetch") start(checked);
    else plan.value = checked;
  }

  /** The switch or new-branch dialog's name changed: the check runs again for it. */
  function recheck(target: string): void {
    const current = plan.value;
    if (!current) return;
    plan.value = precheck(current.kind, overview.targets, target.trim() || null);
  }

  function cancelPlan(): void {
    plan.value = null;
  }

  function confirm(): void {
    const confirmed = plan.value;
    plan.value = null;
    if (confirmed) start(confirmed);
  }

  /** The jobs of `items`: one fetch per repository, the others riding on it. */
  function jobsOf(runKind: BulkKind, items: PlanItem[], prompts: boolean): Job[] {
    const jobs: Job[] = [];
    if (runKind !== "fetch") {
      for (const item of items) {
        jobs.push({ path: item.path, family: familyOf(item.path), prompts, riders: [] });
      }
      return jobs;
    }
    const byFamily = new Map<string, Job>();
    for (const item of items) {
      const family = familyOf(item.path);
      const leader = byFamily.get(family);
      // The repository itself fetches for its worktrees; without it, the first worktree does.
      if (!leader) {
        const job = { path: item.path, family, prompts, riders: [] as string[] };
        byFamily.set(family, job);
        jobs.push(job);
      } else if (item.path === family) {
        leader.riders.push(leader.path);
        leader.path = item.path;
      } else {
        leader.riders.push(item.path);
      }
    }
    return jobs;
  }

  function start(checked: BulkPlan): void {
    states.clear();
    kind.value = checked.kind;
    branch.value = checked.branch;
    for (const item of checked.skipped) {
      states.set(item.path, {
        state: "skipped",
        reason: item.reason ?? "missing",
        operation: item.operation,
        remote: item.remote,
      });
    }
    for (const item of checked.acting) states.set(item.path, { state: "queued" });
    queue.length = 0;
    queue.push(...jobsOf(checked.kind, checked.acting, false));
    begin();
  }

  function begin(): void {
    running.value = queue.length > 0;
    if (!running.value) return;
    opId = newOpId("bulk");
    operations.start(opId, `operations.bulk.${kind.value ?? "fetch"}`, acting.value.length);
    count();
    pump();
  }

  function pump(): void {
    while (running.value && inFlight < BULK_AT_ONCE) {
      const at = queue.findIndex((job) => !families.has(job.prompts ? SIGN_IN_LANE : job.family));
      if (at < 0) break;
      const [job] = queue.splice(at, 1);
      if (!job) break;
      const lane = job.prompts ? SIGN_IN_LANE : job.family;
      inFlight += 1;
      families.add(lane);
      states.set(job.path, { state: "running", progress: null });
      void run(job)
        .then((end) => {
          states.set(job.path, end);
          for (const rider of job.riders) {
            states.set(
              rider,
              end.state === "done"
                ? { state: "done", outcome: "fetched-with", with: nameOf(job.path) }
                : end,
            );
          }
        })
        .finally(() => {
          inFlight -= 1;
          families.delete(lane);
          handles.delete(job.path);
          // A pull or a switch changes the working tree or the index, so the member's lists
          // read again; a fetch, a push and a new branch at HEAD change neither, and a reload
          // is a status of the whole tree, seconds on a large one.
          const touchesTree = kind.value === "pull" || kind.value === "switch";
          const open = useRepoStore();
          for (const path of [job.path, ...job.riders]) {
            overview.refreshOne(path);
            if (touchesTree) folder.reload(path);
            // The open repository's graph, branches and status bar follow its refs.
            if (open.repo && sameFolder(path, open.repo.root)) void open.refreshRefs();
          }
          count();
          pump();
          settle();
        });
    }
  }

  /** The status bar's line and bar: how many members finished of how many. */
  function count(): void {
    if (!opId) return;
    const total = acting.value.length;
    operations.progress(opId, finishedCount.value, total);
    operations.setParams(opId, { done: String(finishedCount.value), total: String(total) });
  }

  /** The run ended once nothing runs or waits. */
  function settle(): void {
    if (inFlight > 0 || queue.length > 0) return;
    running.value = false;
    if (opId) operations.finish(opId);
    opId = null;
  }

  function onEvent(path: string) {
    return (event: NetworkEvent): void => {
      if (event.kind !== "progress") return;
      const current = states.get(path);
      if (current?.state !== "running") return;
      const progress = progressOf(event.line);
      if (progress !== null) states.set(path, { state: "running", progress });
    };
  }

  /** Runs `job`'s operation and says how it ended. */
  async function run(job: Job): Promise<MemberRun> {
    const runKind = kind.value;
    const batch = !job.prompts;
    const id = newOpId(`bulk-${runKind ?? "op"}`);
    try {
      switch (runKind) {
        case "fetch": {
          let summaryLines: string[] = [];
          const handle = ipc.fetch(
            job.path,
            null,
            false,
            (event) => {
              if (event.kind === "result") summaryLines = event.summary;
              onEvent(job.path)(event);
            },
            id,
            batch,
          );
          handles.set(job.path, handle);
          await handle.done;
          return done(summaryLines.some((line) => line.includes("->")) ? "fetched" : "up-to-date");
        }
        case "pull": {
          let outcome: string | null = null;
          const handle = ipc.pull(
            job.path,
            { remote: null, branch: null, rebase: false, ffOnly: true },
            (event) => {
              if (event.kind === "outcome") outcome = event.outcome.kind;
              onEvent(job.path)(event);
            },
            id,
            batch,
          );
          handles.set(job.path, handle);
          await handle.done;
          return done(outcome === "up-to-date" ? "up-to-date" : "fast-forward");
        }
        case "push": {
          const row = overview.rows.find((candidate) => candidate.path === job.path);
          let summaryLines: string[] = [];
          const handle = ipc.push(
            job.path,
            {
              remote: row?.upstream?.remote ?? null,
              branch: row?.branch ?? null,
              tag: null,
              delete: false,
              setUpstream: false,
              forceWithLease: false,
            },
            (event) => {
              if (event.kind === "result") summaryLines = event.summary;
              onEvent(job.path)(event);
            },
            id,
            batch,
          );
          handles.set(job.path, handle);
          await handle.done;
          const nothing = summaryLines.some((line) => line.includes("Everything up-to-date"));
          return done(nothing ? "up-to-date" : "pushed");
        }
        case "switch":
          await ipc.switchTo(job.path, { kind: "branch", name: branch.value ?? "" }, id);
          return done("switched", branch.value ?? "");
        case "create":
          await ipc.branchCreate(job.path, branch.value ?? "", "HEAD", true, false, id);
          return done("created", branch.value ?? "");
        default:
          return { state: "stopped" };
      }
    } catch (error) {
      const failed = toAppError(error);
      if (failed.code === "op.cancelled") return { state: "stopped" };
      const failure = classifyFailure(failed);
      return { state: "failed", ...failure };
    }
  }

  function done(outcome: DoneOutcome, name?: string): MemberRun {
    return { state: "done", outcome, with: name };
  }

  /** Cancels the network operations that run and drops the queued ones (switch and new
   * branch, which cannot be cancelled, finish). */
  async function stop(): Promise<void> {
    for (const job of queue.splice(0)) {
      for (const path of [job.path, ...job.riders]) states.set(path, { state: "stopped" });
    }
    await Promise.all([...handles.values()].map((handle) => handle.cancel()));
    settle();
  }

  /** Runs the failed members again; a sign-in failure alone, with prompts allowed. */
  function retryFailed(): void {
    const failed = [...states.entries()].filter(
      (entry): entry is [string, Extract<MemberRun, { state: "failed" }>] =>
        entry[1].state === "failed",
    );
    if (failed.length === 0 || running.value || kind.value === null) return;
    const runKind = kind.value;
    for (const [path] of failed) states.set(path, { state: "queued" });
    const items = (paths: string[]): PlanItem[] =>
      paths.map((path) => ({
        path,
        name: nameOf(path),
        branch: null,
        upstream: null,
        ahead: null,
        behind: null,
      }));
    const signIn = failed.filter(([, state]) => state.reason === "sign-in").map(([path]) => path);
    const others = failed.filter(([, state]) => state.reason !== "sign-in").map(([path]) => path);
    queue.push(...jobsOf(runKind, items(others), false), ...jobsOf(runKind, items(signIn), true));
    begin();
  }

  /** "Done": the run's states leave the rows. */
  function dismiss(): void {
    if (running.value) return;
    states.clear();
    kind.value = null;
    branch.value = null;
  }

  return {
    plan,
    kind,
    branch,
    states,
    running,
    summary,
    failedPaths,
    finishedCount,
    acting,
    ask,
    recheck,
    cancelPlan,
    confirm,
    stop,
    retryFailed,
    dismiss,
  };
});
