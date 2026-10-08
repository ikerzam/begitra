// "Contained in": the branches, remote branches and tags whose history holds a commit, read
// when the user asks (one walk of the whole history, seconds on a large repository). One read
// runs at a time: asking for another commit, or selecting another row, stops the read in
// flight, and its commit asks again. The answers stay with their commits until a branch, a
// remote branch or a tag moves (HEAD and the stashes leave them standing): then they go, and
// the commit on screen, if it was asked, reads again. Another repository drops them all.

import { defineStore } from "pinia";
import { ref, watch } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { Ref as GitRef } from "@/ipc/schemas";

import { useRepoStore } from "./repo";

/** Where a commit's read stands: reading since `startedAt` (ms), answered, or failed. */
export type Contained =
  | { kind: "reading"; startedAt: number }
  | { kind: "answered"; refs: string[] }
  | { kind: "failed"; error: AppError };

/** The refs as the answers depend on them: each branch, remote branch and tag, and its commit. */
function signature(refs: readonly GitRef[]): string {
  return refs
    .filter(
      (entry) =>
        entry.kind === "local-branch" || entry.kind === "remote-branch" || entry.kind === "tag",
    )
    .map((entry) => `${entry.fullName} ${entry.target}`)
    .join("\n");
}

export const useContainedStore = defineStore("contained", () => {
  const repo = useRepoStore();

  /** By commit hash. */
  const answers = ref<Record<string, Contained>>({});
  /** The read in flight, which a newer one replaces. */
  let reading: { hash: string; opId: string } | null = null;
  let serial = 0;

  function of(hash: string): Contained | null {
    return answers.value[hash] ?? null;
  }

  function put(hash: string, state: Contained): void {
    answers.value = { ...answers.value, [hash]: state };
  }

  /** Forgets a commit's read that never answered, so its line offers "Find" again. */
  function unread(hash: string): void {
    if (answers.value[hash]?.kind !== "reading") return;
    const next = { ...answers.value };
    delete next[hash];
    answers.value = next;
  }

  /** Reads the refs that hold `hash`, stopping the read in flight first. */
  async function find(hash: string): Promise<void> {
    const root = repo.repo?.root;
    if (!root) return;
    stop();
    serial += 1;
    const mine = serial;
    const opId = newOpId("contains");
    reading = { hash, opId };
    put(hash, { kind: "reading", startedAt: Date.now() });
    try {
      const refs = await ipc.refsContaining(root, hash, opId);
      if (mine === serial) put(hash, { kind: "answered", refs });
    } catch (failure) {
      if (mine === serial) put(hash, { kind: "failed", error: toAppError(failure) });
    } finally {
      if (mine === serial) reading = null;
    }
  }

  /** Stops the read in flight; its commit asks again. */
  function stop(): void {
    const current = reading;
    if (!current) return;
    reading = null;
    serial += 1;
    void ipc.cancelOperation(current.opId).catch(() => undefined);
    unread(current.hash);
  }

  function clear(): void {
    stop();
    answers.value = {};
  }

  // Another row: the read in flight is not the one on screen any more.
  watch(
    () => repo.selectedCommit?.hash,
    (hash) => {
      if (reading && reading.hash !== hash) stop();
    },
  );
  // Refs that moved: no answer holds, and the commit on screen asks again if it was asked.
  // Another repository: every answer goes, and nothing is asked.
  watch(
    () => [repo.repo?.root, signature(repo.refs)] as const,
    ([root, refs], [rootBefore, refsBefore]) => {
      if (root === rootBefore && refs === refsBefore) return;
      const shown = repo.selectedCommit?.hash;
      const asked = shown === undefined ? undefined : answers.value[shown]?.kind;
      clear();
      if (root === rootBefore && shown && (asked === "reading" || asked === "answered")) {
        void find(shown);
      }
    },
  );

  return { of, find, stop, clear };
});
