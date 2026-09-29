import { describe, expect, it } from "vitest";

import { atLine, lineTemplates } from "./externalTemplates";

describe("atLine", () => {
  it("gives each known editor its own way of taking a line", () => {
    expect(atLine("code.cmd {path}")).toBe("code.cmd -g {path}:{line}");
    expect(atLine("code {path} --new-window")).toBe("code -g {path}:{line} --new-window");
    expect(atLine("cursor {path}")).toBe("cursor -g {path}:{line}");
    expect(atLine("windsurf {path}")).toBe("windsurf -g {path}:{line}");
    expect(atLine("codium {path}")).toBe("codium -g {path}:{line}");
    expect(atLine("zed {path}")).toBe("zed {path}:{line}");
    expect(atLine("subl {path}")).toBe("subl {path}:{line}");
    expect(atLine("idea64.exe {path}")).toBe("idea64.exe --line {line} {path}");
    expect(atLine("webstorm {path}")).toBe("webstorm --line {line} {path}");
    expect(atLine("notepad++ {path}")).toBe("notepad++ -n{line} {path}");
  });

  it("reads the program's name whatever its folder, extension and case", () => {
    expect(atLine(String.raw`"C:\Program Files\Microsoft VS Code\bin\Code.CMD" "{path}"`)).toBe(
      String.raw`"C:\Program Files\Microsoft VS Code\bin\Code.CMD" -g "{path}":{line}`,
    );
    expect(atLine("/usr/local/bin/PyCharm64 {path}")).toBe(
      "/usr/local/bin/PyCharm64 --line {line} {path}",
    );
  });

  it("leaves an editor it does not know, and a path that is not a word of its own", () => {
    expect(atLine("notepad {path}")).toBeNull();
    expect(atLine("code --folder-uri={path}")).toBeNull();
    expect(atLine("code")).toBeNull();
    expect(atLine("")).toBeNull();
  });
});

describe("lineTemplates", () => {
  it("puts each known editor's line form before the editor itself", () => {
    expect(lineTemplates("", ["code.cmd {path}"])).toEqual([
      "code.cmd -g {path}:{line}",
      "code.cmd {path}",
    ]);
    // An editor it does not know opens the file without the line, before the defaults.
    expect(lineTemplates("", ["notepad {path}", "code.cmd {path}"])).toEqual([
      "notepad {path}",
      "code.cmd -g {path}:{line}",
      "code.cmd {path}",
    ]);
  });

  it("puts Editor at a line first when it is set", () => {
    expect(lineTemplates(" idea64.exe --line {line} {path} ", ["code.cmd {path}"])).toEqual([
      "idea64.exe --line {line} {path}",
      "code.cmd -g {path}:{line}",
      "code.cmd {path}",
    ]);
  });
});
