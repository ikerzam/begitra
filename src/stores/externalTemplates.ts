// "Editor at a line": the templates that open a file at a line. When the setting is empty,
// Begitra derives the line's form from each editor template whose program it knows, from
// that editor's documented command line; the template itself follows, so an editor it does
// not know still opens the file, without the line.

/** How a known editor takes a line: where `{path}` becomes what. */
type LineForm = (path: string) => string[];

const vsCode: LineForm = (path) => ["-g", `${path}:{line}`];
const colon: LineForm = (path) => [`${path}:{line}`];
const jetBrains: LineForm = (path) => ["--line", "{line}", path];
const notepadPlusPlus: LineForm = (path) => ["-n{line}", path];

/** Programs by their file name without extension, in lower case. */
const FORMS: Record<string, LineForm> = {
  code: vsCode,
  "code-insiders": vsCode,
  codium: vsCode,
  cursor: vsCode,
  windsurf: vsCode,
  zed: colon,
  subl: colon,
  sublime_text: colon,
  "notepad++": notepadPlusPlus,
};

const JETBRAINS = [
  "idea",
  "webstorm",
  "pycharm",
  "phpstorm",
  "goland",
  "clion",
  "rider",
  "rustrover",
  "rubymine",
  "datagrip",
  "studio",
];
for (const name of JETBRAINS) {
  FORMS[name] = jetBrains;
  FORMS[`${name}64`] = jetBrains;
}

/** A template's words: whitespace-separated, a double-quoted run kept as one word. */
function words(template: string): string[] {
  return template.match(/"[^"]*"|\S+/g) ?? [];
}

/** The file name of a program without its folder, extension and case: `code` for `C:\VS\bin\Code.CMD`. */
function programName(word: string): string {
  const bare = word.replace(/^"|"$/g, "");
  const file = bare.split(/[\\/]/).pop() ?? bare;
  return file.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

/**
 * The at-line form of an editor template, or null when Begitra does not know the editor or
 * `{path}` is not a word of its own (inside `--folder-uri={path}`, say).
 */
export function atLine(template: string): string | null {
  const parts = words(template);
  const program = parts[0];
  if (program === undefined) return null;
  const form = FORMS[programName(program)];
  const at = parts.findIndex((word) => word === "{path}" || word === '"{path}"');
  if (!form || at < 1) return null;
  const path = parts[at] ?? "{path}";
  return [...parts.slice(0, at), ...form(path), ...parts.slice(at + 1)].join(" ");
}

/**
 * The templates for opening a file at a line: "Editor at a line" when set, then for each
 * editor template (the user's, then the platform's) its at-line form when known, then the
 * template itself.
 */
export function lineTemplates(lineCommand: string, editorTemplates: readonly string[]): string[] {
  const derived = editorTemplates.flatMap((template) => {
    const form = atLine(template);
    return form === null ? [template] : [form, template];
  });
  const all = lineCommand.trim() === "" ? derived : [lineCommand.trim(), ...derived];
  return [...new Set(all)];
}
