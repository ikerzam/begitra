// The notes of a review as Markdown, the form an agent's prompt takes: a heading naming the
// target, then each note under its path, in path order, a resolved note followed by its
// resolution.

/**
 * `path` as inline code, fenced by one backtick more than the longest run inside it, with a
 * space inside the fence when the path starts or ends with a backtick (CommonMark strips it).
 */
function code(path: string): string {
  const longest = Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = path.startsWith("`") || path.endsWith("`") ? " " : "";
  return `${fence}${pad}${path}${pad}${fence}`;
}

/**
 * The notes under the heading `title`, one section per path; a note with a resolution is
 * followed by the line `resolved` writes for its reply.
 */
export function notesMarkdown(
  title: string,
  notes: ReadonlyMap<string, string>,
  resolutions: ReadonlyMap<string, { reply: string }> = new Map(),
  resolved: (reply: string) => string = (reply) =>
    reply === "" ? "**Resolved**" : `**Resolved:** ${reply}`,
): string {
  const lines = [`# ${title}`, ""];
  const paths = [...notes.keys()].sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    lines.push(`## ${code(path)}`, "", notes.get(path) ?? "", "");
    const resolution = resolutions.get(path);
    if (resolution) lines.push(resolved(resolution.reply), "");
  }
  return lines.join("\n");
}
