// A file of the working tree from its repository's root and its repository-relative path,
// with the root's own separator: the editor and the terminal take it either way, and the
// toasts show it the way the platform writes it.

export function joinPath(root: string, relative: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  const inner = separator === "\\" ? relative.replaceAll("/", "\\") : relative;
  return `${root.replace(/[\\/]+$/, "")}${separator}${inner.replace(/^[\\/]+/, "")}`;
}
