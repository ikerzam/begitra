// Keeping popups inside the window: 8px from its edges, on the other side of their point or
// control when the asked side would cross one, and pushed back along an edge when neither side
// has room. Pure: the components measure, these decide.

/** The gap popups keep from the window's edges: --space-2, as the hover card. */
export const EDGE = 8;

export interface Size {
  width: number;
  height: number;
}

/** A rectangle in viewport coordinates, as `getBoundingClientRect` gives it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The edge of its control a hanging popup lines up with, and the side it hangs on. */
export interface Side {
  align: "start" | "end";
  placement: "top" | "bottom";
}

function clamp(start: number, length: number, room: number): number {
  return Math.max(EDGE, Math.min(start, room - EDGE - length));
}

/**
 * Where a popup opened at a point goes (a context menu): right and below the point, on its
 * other side along an axis where it would cross the window's edge, then clamped inside.
 */
export function placeAtPoint(
  point: { x: number; y: number },
  size: Size,
  viewport: Size,
): { left: number; top: number } {
  // Nothing laid out (no layout engine, nothing rendered yet): the asked place stands.
  if (size.width === 0 && size.height === 0) return { left: point.x, top: point.y };
  const left = point.x + size.width > viewport.width - EDGE ? point.x - size.width : point.x;
  const top = point.y + size.height > viewport.height - EDGE ? point.y - size.height : point.y;
  return {
    left: clamp(left, size.width, viewport.width),
    top: clamp(top, size.height, viewport.height),
  };
}

/**
 * The side a popup hanging from a control takes, given the box it has on its current side:
 * the control's other edge when it crosses the window's left or right and fits there, the
 * control's other side when it crosses the top or the bottom and fits there.
 */
export function fitSide(box: Box, control: Box, side: Side, viewport: Size): Side {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (width === 0 && height === 0) return side;
  let align = side.align;
  if (align === "start" && box.right > viewport.width - EDGE && control.right - width >= EDGE) {
    align = "end";
  } else if (align === "end" && box.left < EDGE && control.left + width <= viewport.width - EDGE) {
    align = "start";
  }
  let placement = side.placement;
  if (placement === "bottom" && box.bottom > viewport.height - EDGE) {
    const gap = box.top - control.bottom;
    if (control.top - gap - height >= EDGE) placement = "top";
  } else if (placement === "top" && box.top < EDGE) {
    const gap = control.top - box.bottom;
    if (control.bottom + gap + height <= viewport.height - EDGE) placement = "bottom";
  }
  return { align, placement };
}

/** The gap between a control and what hangs from it (a list, a tooltip): --space-1. */
export const HANG_GAP = 4;

/**
 * Where a popup hanging from a control goes (a select's options, a tooltip), given its
 * natural size: on the `prefer`red side of the control (under it by default), on the other
 * side when it fits there and not on its own, else on the side with more room with its height
 * cut to that room; lined up with the control's left edge, or with its right edge when the
 * popup would cross the window's right and fits that way, then kept inside the window.
 * `height` is the height to show, null when nothing is laid out yet.
 */
export function hangFrom(
  control: Box,
  size: Size,
  viewport: Size,
  prefer: "bottom" | "top" = "bottom",
): { left: number; top: number; height: number | null } {
  if (size.width === 0 && size.height === 0) {
    const top = prefer === "bottom" ? control.bottom + HANG_GAP : control.top - HANG_GAP;
    return { left: control.left, top, height: null };
  }
  const below = viewport.height - EDGE - control.bottom - HANG_GAP;
  const above = control.top - HANG_GAP - EDGE;
  const [own, other] = prefer === "bottom" ? [below, above] : [above, below];
  const stays = size.height <= own || (size.height > other && own >= other);
  const under = prefer === "bottom" ? stays : !stays;
  const height = Math.max(0, Math.min(size.height, under ? below : above));
  const top = under ? control.bottom + HANG_GAP : control.top - HANG_GAP - height;
  const crosses = control.left + size.width > viewport.width - EDGE;
  const left =
    crosses && control.right - size.width >= EDGE ? control.right - size.width : control.left;
  return { left: clamp(left, size.width, viewport.width), top, height };
}

/** The window's size, or an unbounded one where there is no window. */
export function viewportSize(): Size {
  return typeof window === "undefined"
    ? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }
    : { width: window.innerWidth, height: window.innerHeight };
}
