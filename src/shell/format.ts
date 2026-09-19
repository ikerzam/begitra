// Pure formatting helpers for the shell: relative and absolute dates, short hashes.

export type RelativeUnit = "now" | "minutes" | "hours" | "days" | "weeks" | "months" | "years";

export interface RelativeDate {
  /** i18n unit; the message is `date.<unit>` with `{n}`. */
  unit: RelativeUnit;
  n: number;
}

/** How long ago `unixSeconds` was, in the short style of the design ("2h ago", "3w ago"). */
export function relativeDate(unixSeconds: number, nowMs: number = Date.now()): RelativeDate {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (seconds < 60) return { unit: "now", n: 0 };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "minutes", n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", n: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { unit: "days", n: days };
  const weeks = Math.floor(days / 7);
  if (days < 30) return { unit: "weeks", n: weeks };
  const months = Math.floor(days / 30);
  if (days < 365) return { unit: "months", n: months };
  return { unit: "years", n: Math.floor(days / 365) };
}

/** The absolute date in the viewer's locale and time zone, e.g. "15 Sep 2026, 15:42". */
export function absoluteDate(unixSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(unixSeconds * 1000),
  );
}

/** The first seven characters of a hash. */
export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/** The last path segment, for repository names. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

/** Thousands separators in the viewer's locale. */
export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}
