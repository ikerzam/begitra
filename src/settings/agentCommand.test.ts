import { describe, expect, it } from "vitest";

import { agentCommand, quotedPath } from "./agentCommand";

describe("agentCommand", () => {
  it("registers the server for every project, its path quoted for Windows", () => {
    expect(agentCommand("C:\\Program Files\\Begitra\\begitra-mcp.exe", "windows")).toBe(
      'claude mcp add --scope user begitra -- "C:\\Program Files\\Begitra\\begitra-mcp.exe"',
    );
  });

  it("quotes a path for a POSIX shell, a single quote inside included", () => {
    expect(quotedPath("/opt/begitra/begitra-mcp", "linux")).toBe("'/opt/begitra/begitra-mcp'");
    expect(quotedPath("/Users/ana/it's here/begitra-mcp", "macos")).toBe(
      "'/Users/ana/it'\\''s here/begitra-mcp'",
    );
    expect(quotedPath("/tmp/$HOME `x`", "linux")).toBe("'/tmp/$HOME `x`'");
  });
});
