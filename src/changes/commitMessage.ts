// A co-author added to a commit message's body, as git's trailers read it.

/** A trailer line as `git interpret-trailers` reads one: a token without spaces, a colon, a
 * value. */
const TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*:[ \t]*\S/;
/** A co-author trailer, with the email it names. */
const CO_AUTHOR = /^co-authored-by:.*<([^>]*)>\s*$/i;

/**
 * `body` with `Co-authored-by: <name> <<email>>` at its end: on its own line when the body's
 * last paragraph is a block of trailers (a `Signed-off-by` among them), after a blank line
 * otherwise, alone in an empty body; the body as it was when a co-author trailer names that
 * email already (compared without case).
 */
export function withCoAuthor(body: string, name: string, email: string): string {
  const trimmed = body.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  const named = lines.some(
    (line) => CO_AUTHOR.exec(line.trim())?.[1]?.toLowerCase() === email.toLowerCase(),
  );
  if (named) return body;
  const trailer = `Co-authored-by: ${name} <${email}>`;
  if (trimmed === "") return trailer;
  const last = trimmed.split(/\n[ \t]*\n/).at(-1) ?? "";
  const block = last.split("\n").every((line) => TRAILER.test(line));
  return block ? `${trimmed}\n${trailer}` : `${trimmed}\n\n${trailer}`;
}
