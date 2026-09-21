// The shape of a branch or tag name git accepts (the bridge checks the same rules again).

const FORBIDDEN = /[\s~^:?*[\\]/;

export function validName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("-") || trimmed.length > 200) return false;
  if (FORBIDDEN.test(trimmed) || trimmed.includes("..") || trimmed.includes("@{")) return false;
  if (trimmed.endsWith("/") || trimmed.endsWith(".") || trimmed === "@") return false;
  return trimmed
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}
