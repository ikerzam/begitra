// The icon of a file's kind for the file rows, chosen by its name. In order: a lockfile (the
// app's one list, so `pnpm-lock.yaml` is a lockfile though it ends in `.yaml`), a well-known
// name, a dotfile of configuration, the extension, a name that starts like a well-known one
// (`LICENSE-MIT`), and the plain file icon otherwise. A path ending in `/` (a nested repository, a
// submodule) is a folder and has none. Lucide's file icons, drawn monochrome by the row.

import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideoCamera,
} from "@lucide/vue";
import type { Component } from "vue";

import { isLockfile } from "./lockfiles";

/** Whole names, lower case, whose kind their extension does not say or which have none. */
const NAMES: Record<string, Component> = {
  ".env": FileKey,
  dockerfile: FileCog,
  containerfile: FileCog,
  ".editorconfig": FileCog,
  ".gitattributes": FileCog,
  ".gitmodules": FileCog,
  "go.mod": FileCog,
  "go.work": FileCog,
  makefile: FileTerminal,
  justfile: FileTerminal,
  "cmakelists.txt": FileCode,
};

/** Names that start like these, before a `.` or a `-`, are prose: `README`, `LICENSE-MIT`. */
const PROSE_STEMS = new Set([
  "readme",
  "license",
  "licence",
  "changelog",
  "authors",
  "notice",
  "copying",
]);

/** Extensions without their dot, lower case and space-separated, by kind. */
const KINDS: [Component, string][] = [
  [FileKey, "pem key crt cer der p12 pfx gpg asc keystore jks env"],
  [FileCog, "toml yaml yml ini cfg conf properties plist dockerfile"],
  [FileBraces, "json jsonc json5 jsonl ndjson geojson webmanifest"],
  [FileTerminal, "sh bash zsh fish ps1 psm1 bat cmd nu"],
  [
    FileCode,
    "ts tsx mts cts js jsx mjs cjs vue svelte astro rs go py pyi rb java kt kts scala swift " +
      "c h cc cpp cxx hpp hh m mm cs fs fsx vb php lua dart ex exs erl hrl hs ml mli clj cljs " +
      "elm r jl zig nim sol sql graphql gql proto wgsl glsl hlsl css scss sass less styl html " +
      "htm xml xsl xaml csproj sln gradle cmake tf hcl nix wasm ipynb",
  ],
  [FileText, "md mdx mdc markdown txt text rst adoc org tex log rtf pdf"],
  [FileImage, "png jpg jpeg gif webp avif bmp ico icns svg tif tiff psd"],
  [FileArchive, "zip tar gz tgz bz2 xz 7z rar zst jar whl"],
  [FileSpreadsheet, "csv tsv xls xlsx ods parquet"],
  [FileType, "ttf otf woff woff2 eot"],
  [FileVideoCamera, "mp4 mov webm mkv avi m4v"],
  [FileMusic, "mp3 wav flac ogg m4a aac opus"],
];

const BY_EXTENSION = new Map<string, Component>(
  KINDS.flatMap(([icon, extensions]) =>
    extensions.split(" ").map((extension) => [extension, icon] as const),
  ),
);

/**
 * The icon of the kind of the file a name or a path ends in; `null` for a path ending in `/`,
 * which names a folder.
 */
export function fileIconOf(path: string): Component | null {
  if (path.endsWith("/")) return null;
  const original = path.split(/[/\\]/).pop() ?? "";
  if (isLockfile(original)) return FileLock;
  const name = original.toLowerCase();
  const known = NAMES[name];
  if (known) return known;
  if (name.startsWith(".env.")) return FileKey;
  if (name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return FileCog;
  const dot = name.lastIndexOf(".");
  // A dotfile's only dot starts its name: `.eslintrc`, `.npmignore` are configuration.
  if (dot === 0) return /(rc|ignore)$/.test(name) ? FileCog : File;
  const byExtension = dot > 0 ? BY_EXTENSION.get(name.slice(dot + 1)) : undefined;
  if (byExtension) return byExtension;
  return PROSE_STEMS.has(name.split(/[.-]/)[0] ?? "") ? FileText : File;
}
