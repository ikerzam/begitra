import { describe, expect, it } from "vitest";

import { fontSuggestions } from "./fontSuggestions";

describe("fontSuggestions", () => {
  it("offers the platform's own fonts first, then the ones installed anywhere", () => {
    const windows = fontSuggestions("windows");
    expect(windows.ui.slice(0, 2)).toEqual(["Segoe UI", "Segoe UI Variable Text"]);
    // The bare family name of Windows 11's font resolves to nothing in a webview.
    expect(windows.ui).not.toContain("Segoe UI Variable");
    expect(windows.code.slice(0, 3)).toEqual(["Cascadia Code", "Cascadia Mono", "Consolas"]);
    expect(fontSuggestions("macos").code).toContain("Menlo");
    expect(fontSuggestions("linux").ui).toContain("Ubuntu");
    for (const platform of ["windows", "macos", "linux"] as const) {
      expect(fontSuggestions(platform).code).toContain("JetBrains Mono");
      expect(fontSuggestions(platform).ui).toContain("Inter");
    }
  });
});
