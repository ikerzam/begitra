// Motion: rows collapse and expand for `--motion-duration`, only in
// answer to the user's own action. A store arms a list right before it applies such a change,
// and `MotionRows` animates the list while it is armed; a change nobody armed (the watcher's, a
// scan's) shows at once. The system's reduced motion preference turns every list off.

import { reactive, ref } from "vue";

/** The lists whose rows move. */
export type MotionList = "changes" | "branches" | "stash" | "worktrees" | "projects";

/** `--motion-duration` in milliseconds; a list stays armed for twice as long. */
export const MOTION_MS = 140;

/**
 * The most rows a list animates: `TransitionGroup` measures every row on each render, and the
 * changes lists are not virtualised.
 */
export const MOTION_MAX_ROWS = 200;

/** When each list's arming runs out, in `performance.now()` milliseconds. */
const armedUntil = reactive<Record<MotionList, number>>({
  changes: 0,
  branches: 0,
  stash: 0,
  worktrees: 0,
  projects: 0,
});

const preference =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/** Whether the system asks for reduced motion; follows the preference while the app runs. */
export const reducedMotion = ref(preference?.matches ?? false);
preference?.addEventListener("change", (event) => {
  reducedMotion.value = event.matches;
});

/** Marks `list` as changing because the user asked: the change about to land animates. */
export function arm(list: MotionList): void {
  armedUntil[list] = performance.now() + 2 * MOTION_MS;
}

/** Whether a change of `list` rendered now answers the user's action and may move. */
export function armed(list: MotionList): boolean {
  return !reducedMotion.value && armedUntil[list] > performance.now();
}
