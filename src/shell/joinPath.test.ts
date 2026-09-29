import { describe, expect, it } from "vitest";

import { joinPath } from "./joinPath";

describe("joinPath", () => {
  it("joins with the root's own separator", () => {
    expect(joinPath(String.raw`C:\code\geo`, "src/map/worker-pool.ts")).toBe(
      String.raw`C:\code\geo\src\map\worker-pool.ts`,
    );
    expect(joinPath("/home/iker/geo", "src/map/worker-pool.ts")).toBe(
      "/home/iker/geo/src/map/worker-pool.ts",
    );
  });

  it("takes one separator between a root that ends in one and a path that starts with one", () => {
    expect(joinPath(String.raw`C:\code\geo\\`, "/src/a.ts")).toBe(String.raw`C:\code\geo\src\a.ts`);
    expect(joinPath("/r/", "a b/ñandú.ts")).toBe("/r/a b/ñandú.ts");
  });
});
