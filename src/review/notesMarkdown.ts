// The notes of a review as Markdown, the form an agent's prompt takes: the target as the
// heading, then each note under its path, in path order.

/** `path` as inline code, fenced by one backtick more than the longest run inside it. */
function code(path: string): string {
  const longest = Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${path}${fence}`;
}

/** The notes of the target named `label`, one section per path. */
export function notesMarkdown(label: string, notes: ReadonlyMap<string, string>): string {
  const lines = [`# Review notes: ${label}`, ""];
  const paths = [...notes.keys()].sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    lines.push(`## ${code(path)}`, "", notes.get(path) ?? "", "");
  }
  return lines.join("\n");
}
