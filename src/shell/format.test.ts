import { describe, expect, it } from "vitest";

import {
  abbreviateHome,
  absoluteDate,
  baseName,
  formatCount,
  relativeDate,
  sameFolder,
  shortHash,
} from "./format";

const now = Date.UTC(2026, 8, 19, 12, 0, 0);
const at = (secondsAgo: number) => Math.floor(now / 1000) - secondsAgo;

describe("relativeDate", () => {
  it("uses the short units of the design", () => {
    expect(relativeDate(at(10), now)).toEqual({ unit: "now", n: 0 });
    expect(relativeDate(at(5 * 60), now)).toEqual({ unit: "minutes", n: 5 });
    expect(relativeDate(at(2 * 3600), now)).toEqual({ unit: "hours", n: 2 });
    expect(relativeDate(at(3 * 86_400), now)).toEqual({ unit: "days", n: 3 });
    expect(relativeDate(at(20 * 86_400), now)).toEqual({ unit: "weeks", n: 2 });
    expect(relativeDate(at(100 * 86_400), now)).toEqual({ unit: "months", n: 3 });
    expect(relativeDate(at(800 * 86_400), now)).toEqual({ unit: "years", n: 2 });
    expect(relativeDate(at(-50), now)).toEqual({ unit: "now", n: 0 });
  });
});

describe("other helpers", () => {
  it("formats absolute dates, hashes, names and counts", () => {
    expect(absoluteDate(Math.floor(now / 1000), "en")).toMatch(/2026/);
    expect(shortHash("a1b2c3d4e5f6")).toBe("a1b2c3d");
    expect(baseName("C:\\Code\\begira")).toBe("begira");
    expect(baseName("/home/iker/code/begira/")).toBe("begira");
    expect(baseName("begira")).toBe("begira");
    expect(formatCount(48210, "en")).toBe("48,210");
  });
});

describe("folders", () => {
  it("compares folders ignoring trailing separators, and case on Windows paths", () => {
    expect(sameFolder("/home/iker/code", "/home/iker/code/")).toBe(true);
    expect(sameFolder("/home/iker/code", "/home/iker/wt")).toBe(false);
    expect(sameFolder("/home/Iker/code", "/home/iker/code")).toBe(false);
    expect(sameFolder("C:\\Users\\iker\\code", "c:/users/iker/code/")).toBe(true);
    expect(sameFolder("C:\\Users\\iker\\code", "C:\\Users\\iker\\code2")).toBe(false);
  });

  it("abbreviates the home folder to a tilde", () => {
    expect(abbreviateHome("/home/iker/code/geoportal", "/home/iker")).toBe("~/code/geoportal");
    expect(abbreviateHome("/home/iker/code/geoportal", "/home/iker/")).toBe("~/code/geoportal");
    expect(abbreviateHome("/home/ikerz/code", "/home/iker")).toBe("/home/ikerz/code");
    expect(abbreviateHome("C:\\Users\\iker\\wt\\x", "C:\\Users\\iker")).toBe("~\\wt\\x");
    expect(abbreviateHome("c:\\users\\iker", "C:\\Users\\iker\\")).toBe("~");
    expect(abbreviateHome("/wt/claude-auth", null)).toBe("/wt/claude-auth");
  });
});
