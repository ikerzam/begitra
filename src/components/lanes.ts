/**
 * Graph lane colours. Lanes are numbered from 1 and cycle every eight. The class names are
 * spelled out in full because Tailwind only generates utilities it can find in the source.
 */
export const LANE_COUNT = 8;

const backgrounds = [
  "bg-lane-1",
  "bg-lane-2",
  "bg-lane-3",
  "bg-lane-4",
  "bg-lane-5",
  "bg-lane-6",
  "bg-lane-7",
  "bg-lane-8",
] as const;

const foregrounds = [
  "text-lane-1",
  "text-lane-2",
  "text-lane-3",
  "text-lane-4",
  "text-lane-5",
  "text-lane-6",
  "text-lane-7",
  "text-lane-8",
] as const;

/** Maps any positive lane number onto 1..8. Values below 1 land on lane 1. */
export function laneIndex(lane: number): number {
  const normalized = Number.isFinite(lane) ? Math.max(1, Math.trunc(lane)) : 1;
  return ((normalized - 1) % LANE_COUNT) + 1;
}

export function laneBgClass(lane: number): string {
  return backgrounds[laneIndex(lane) - 1] ?? backgrounds[0];
}

export function laneTextClass(lane: number): string {
  return foregrounds[laneIndex(lane) - 1] ?? foregrounds[0];
}
