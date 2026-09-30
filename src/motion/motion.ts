// Motion: rows collapse and expand for `--motion-duration`, only in
// answer to the user's own action. A store arms a list right before it applies such a change,
// and `MotionRows` animates the list while it is armed; the arming ends on a timer, so a
// change nobody armed (the watcher's, a scan's) shows at once. The system's reduced motion
// preference turns every list off.

import { reactive, ref } from "vue";

/** The lists whose rows move. */
export type MotionList = "changes" | "branches" | "stash" | "worktrees" | "projects";

/**
 * The most rows a list animates: `TransitionGroup` measures every row on each render, and the
 * changes lists are not virtualised.
 */
export const MOTION_MAX_ROWS = 200;

/** `--motion-duration` as the page reads it, in milliseconds; 140 without the style sheet. */
export function motionMs(): number {
  if (typeof document === "undefined") return 140;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--motion-duration")
    .trim();
  const ms = value.endsWith("ms")
    ? Number.parseFloat(value)
    : value.endsWith("s")
      ? Number.parseFloat(value) * 1000
      : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 140;
}

/** The lists a user's action is changing now. */
const armedLists = reactive<Record<MotionList, boolean>>({
  changes: false,
  branches: false,
  stash: false,
  worktrees: false,
  projects: false,
});
const timers = new Map<MotionList, ReturnType<typeof setTimeout>>();

const preference =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/** Whether the system asks for reduced motion; follows the preference while the app runs. */
export const reducedMotion = ref(preference?.matches ?? false);
preference?.addEventListener("change", (event) => {
  reducedMotion.value = event.matches;
});

/**
 * Marks `list` as changing because the user asked: the change about to land animates, and the
 * list is at rest again after twice the duration.
 */
export function arm(list: MotionList): void {
  armedLists[list] = true;
  const running = timers.get(list);
  if (running !== undefined) clearTimeout(running);
  timers.set(
    list,
    setTimeout(() => {
      timers.delete(list);
      armedLists[list] = false;
    }, 2 * motionMs()),
  );
}

/** Whether a change of `list` rendered now answers the user's action and may move. */
export function armed(list: MotionList): boolean {
  return !reducedMotion.value && armedLists[list];
}
