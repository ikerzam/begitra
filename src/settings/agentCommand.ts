// The command that registers Begitra's agent server with Claude Code, as Settings › Agents
// shows it to copy: the server's path quoted for the shell the user runs it in.

import type { Platform } from "@/shortcuts/platform";

/**
 * `path` as one argument of the platform's shell: in double quotes on Windows (cmd and
 * PowerShell take them, and a Windows path cannot hold one), in single quotes elsewhere, where
 * nothing inside is special but the quote itself.
 */
export function quotedPath(path: string, platform: Platform): string {
  if (platform === "windows") return `"${path}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** `claude mcp add` for the server at `path`, for every project of the user. */
export function agentCommand(path: string, platform: Platform): string {
  return `claude mcp add --scope user begitra -- ${quotedPath(path, platform)}`;
}
