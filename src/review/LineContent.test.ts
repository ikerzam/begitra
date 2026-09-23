import { describe, expect, it } from "vitest";

import type { DiffLine, Token } from "@/ipc/schemas";
import { mountWithI18n } from "@/test/mount";

import LineContent from "./LineContent.vue";

function line(
  text: string,
  kind: DiffLine["kind"] = "context",
  spans: DiffLine["spans"] = [],
): DiffLine {
  return { kind, oldNumber: 1, newNumber: 1, text, spans, noNewline: false };
}

/** The rendered pieces of the line as `[text, classes]`, plain text included. */
function pieces(
  text: string,
  tokens: Token[],
  kind: DiffLine["kind"] = "context",
  spans: DiffLine["spans"] = [],
) {
  const wrapper = mountWithI18n(LineContent, { props: { line: line(text, kind, spans), tokens } });
  const root = wrapper.get("[data-testid='line-content']").element;
  return Array.from(root.childNodes).map((node): [string, string] => [
    node.textContent ?? "",
    node instanceof HTMLElement ? node.className : "",
  ]);
}

describe("LineContent", () => {
  it("colours every token class with its syntax token and leaves plain text alone", () => {
    const text = "const total = sum(items, 3); // cents 'x' Foo";
    const at = (piece: string) => text.indexOf(piece);
    const tokens: Token[] = [
      { start: 0, end: 5, class: "keyword" },
      { start: at("="), end: at("=") + 1, class: "punctuation" },
      { start: at("sum"), end: at("sum") + 3, class: "function" },
      { start: at("3"), end: at("3") + 1, class: "number" },
      { start: at("//"), end: at("//") + 8, class: "comment" },
      { start: at("'x'"), end: at("'x'") + 3, class: "string" },
      { start: at("Foo"), end: at("Foo") + 3, class: "type" },
    ];
    const byText = Object.fromEntries(pieces(text, tokens));
    expect(byText["const"]).toBe("text-syntax-keyword");
    expect(byText["="]).toBe("text-fg-secondary");
    expect(byText["sum"]).toBe("text-syntax-function");
    expect(byText["3"]).toBe("text-syntax-number");
    expect(byText["// cents"]).toBe("text-syntax-comment");
    expect(byText["'x'"]).toBe("text-syntax-string");
    expect(byText["Foo"]).toBe("text-syntax-type");
    // Plain text is a text node: the line's own colour.
    expect(byText[" total "]).toBe("");
  });

  it("keeps the emphasis background on a coloured span", () => {
    const text = "return value;";
    const result = pieces(text, [{ start: 0, end: 6, class: "keyword" }], "added", [
      { start: 0, end: 6 },
    ]);
    const [, classes] = result.find(([piece]) => piece === "return") ?? ["", ""];
    expect(classes.split(" ")).toEqual(
      expect.arrayContaining(["text-syntax-keyword", "bg-add-emphasis"]),
    );
  });
});
