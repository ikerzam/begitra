// A clock for relative dates: the current time, refreshed on an interval while the component
// is mounted, so "2m ago" keeps moving instead of freezing at mount.

import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/** Milliseconds between refreshes; relative dates never show seconds. */
export const NOW_REFRESH_MS = 60_000;

export function useNow(intervalMs = NOW_REFRESH_MS): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    timer = setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  });
  onBeforeUnmount(() => {
    if (timer !== undefined) clearInterval(timer);
  });
  return now;
}
