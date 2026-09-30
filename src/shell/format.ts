// Pure formatting helpers for the shell: relative and absolute dates, short hashes, paths.

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

/** Whether `path` is spelled the Windows way (a drive letter or a UNC prefix). */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("\\\\");
}

/** A comparable form of a folder: one separator, no trailing separator, case folded on Windows. */
export function folderKey(path: string): string {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWindowsPath(path) ? unified.toLowerCase() : unified;
}

/** Whether two spellings name the same folder (separators and trailing slashes aside). */
export function sameFolder(a: string, b: string): boolean {
  return folderKey(a) === folderKey(b);
}

/** Whether `path` lies under `folder`, the folder itself left out, however each is spelled. */
export function isUnder(folder: string, path: string): boolean {
  const base = folderKey(folder);
  return base !== "" && folderKey(path).startsWith(`${base}/`);
}

/** `path` under `folder`, with `/` separators; the whole path when it is not under it. */
export function pathUnder(folder: string, path: string): string {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = `${norm(folder)}/`;
  const full = norm(path);
  return full.toLowerCase().startsWith(base.toLowerCase()) ? full.slice(base.length) : full;
}

/** `path` with the home folder replaced by `~`; unchanged otherwise. */
export function abbreviateHome(path: string, home: string | null): string {
  if (!home) return path;
  const key = folderKey(path);
  const homeKey = folderKey(home);
  if (homeKey === "") return path;
  if (key === homeKey) return "~";
  if (!key.startsWith(`${homeKey}/`)) return path;
  const separator = path.includes("\\") ? "\\" : "/";
  const rest = path.replace(/[\\/]+$/, "").slice(homeKey.length + 1);
  return `~${separator}${rest}`;
}
