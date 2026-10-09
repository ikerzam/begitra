import { describe, expect, it } from "vitest";

import { withCoAuthor } from "./commitMessage";

describe("a co-author in the body", () => {
  const ana = ["Ana Ruiz", "ana@example.com"] as const;

  it("goes after a blank line, or alone in an empty body", () => {
    expect(withCoAuthor("Speeds up the tile cache.", ...ana)).toBe(
      "Speeds up the tile cache.\n\nCo-authored-by: Ana Ruiz <ana@example.com>",
    );
    expect(withCoAuthor("", ...ana)).toBe("Co-authored-by: Ana Ruiz <ana@example.com>");
    expect(withCoAuthor("  \n", ...ana)).toBe("Co-authored-by: Ana Ruiz <ana@example.com>");
  });

  it("joins a trailer block the body ends with", () => {
    expect(withCoAuthor("Body.\n\nSigned-off-by: Iker Z. <iker@example.com>\n", ...ana)).toBe(
      "Body.\n\nSigned-off-by: Iker Z. <iker@example.com>\nCo-authored-by: Ana Ruiz <ana@example.com>",
    );
    // A last paragraph that is prose with a colon is no trailer block.
    expect(withCoAuthor("Body.\n\nThe cache: it kept them.", ...ana)).toBe(
      "Body.\n\nThe cache: it kept them.\n\nCo-authored-by: Ana Ruiz <ana@example.com>",
    );
  });

  it("adds nothing for an email the body names already", () => {
    const body = "Body.\n\nCo-authored-by: Ana R. <ANA@example.com>";
    expect(withCoAuthor(body, ...ana)).toBe(body);
    expect(withCoAuthor(body, "Luis Pardo", "luis@example.com")).toBe(
      `${body}\nCo-authored-by: Luis Pardo <luis@example.com>`,
    );
  });
});
