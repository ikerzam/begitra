// The clipboard of the webview, for the copy actions (a commit's hash or message, the review
// notes).

/** Writes `text` to the clipboard; false when the webview offers none. */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
