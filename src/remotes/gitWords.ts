// git's words for the refusals the network's toasts and the bulk rows explain: `LC_ALL=C`
// keeps them in English whatever the user's locale (the engine's `WRITE_ENV`).

/** A fast-forward-only pull found the branch and what it pulls diverged. */
export const DIVERGED_PULL =
  /Not possible to fast-forward|Diverging branches can't be fast-forwarded/;

/** git refused a fast-forward-only pull because the branch and what it pulls diverged. */
export function isDivergedPull(output: string): boolean {
  return DIVERGED_PULL.test(output);
}
