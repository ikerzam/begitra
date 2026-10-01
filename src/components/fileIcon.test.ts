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
import { describe, expect, it } from "vitest";

import { fileIconOf } from "./fileIcon";

describe("fileIconOf", () => {
  it("knows a file's kind by its extension", () => {
    expect(fileIconOf("tile-cache.ts")).toBe(FileCode);
    expect(fileIconOf("worker_pool.rs")).toBe(FileCode);
    expect(fileIconOf("App.vue")).toBe(FileCode);
    expect(fileIconOf("site.css")).toBe(FileCode);
    expect(fileIconOf("package.json")).toBe(FileBraces);
    expect(fileIconOf("pnpm-workspace.yaml")).toBe(FileCog);
    expect(fileIconOf("Cargo.toml")).toBe(FileCog);
    expect(fileIconOf("release.sh")).toBe(FileTerminal);
    expect(fileIconOf("install.ps1")).toBe(FileTerminal);
    expect(fileIconOf("notes.md")).toBe(FileText);
    expect(fileIconOf("logo.svg")).toBe(FileImage);
    expect(fileIconOf("bundle.tar.gz")).toBe(FileArchive);
    expect(fileIconOf("results.csv")).toBe(FileSpreadsheet);
    expect(fileIconOf("geist.woff2")).toBe(FileType);
    expect(fileIconOf("demo.mp4")).toBe(FileVideoCamera);
    expect(fileIconOf("chime.wav")).toBe(FileMusic);
    expect(fileIconOf("server.pem")).toBe(FileKey);
  });

  it("knows the app's lockfiles, and those alone, by their exact name", () => {
    expect(fileIconOf("pnpm-lock.yaml")).toBe(FileLock);
    expect(fileIconOf("package-lock.json")).toBe(FileLock);
    expect(fileIconOf("Cargo.lock")).toBe(FileLock);
    expect(fileIconOf("go.sum")).toBe(FileLock);
    // Not in the list "Hide lockfiles" uses, so not drawn as one either.
    expect(fileIconOf("flake.lock")).toBe(File);
    expect(fileIconOf("npm-shrinkwrap.json")).toBe(FileBraces);
  });

  it("knows a well-known name before its extension", () => {
    expect(fileIconOf(".env")).toBe(FileKey);
    expect(fileIconOf(".env.local")).toBe(FileKey);
    expect(fileIconOf("Dockerfile")).toBe(FileCog);
    expect(fileIconOf("Dockerfile.dev")).toBe(FileCog);
    expect(fileIconOf("api.dockerfile")).toBe(FileCog);
    expect(fileIconOf("Containerfile")).toBe(FileCog);
    expect(fileIconOf("go.mod")).toBe(FileCog);
    expect(fileIconOf("Makefile")).toBe(FileTerminal);
    expect(fileIconOf("CMakeLists.txt")).toBe(FileCode);
    expect(fileIconOf("README")).toBe(FileText);
    expect(fileIconOf("LICENSE")).toBe(FileText);
    expect(fileIconOf("LICENSE-MIT")).toBe(FileText);
    expect(fileIconOf("LICENSE-APACHE")).toBe(FileText);
    // A known extension wins over a name that starts like prose.
    expect(fileIconOf("license-checker.js")).toBe(FileCode);
  });

  it("reads a dotfile of configuration by its ending", () => {
    for (const name of [".gitignore", ".npmignore", ".eslintrc", ".babelrc", ".npmrc", ".nvmrc"]) {
      expect(fileIconOf(name), name).toBe(FileCog);
    }
    expect(fileIconOf(".editorconfig")).toBe(FileCog);
    expect(fileIconOf(".eslintrc.json")).toBe(FileBraces);
  });

  it("knows the files agents leave in a repository", () => {
    expect(fileIconOf("events.jsonl")).toBe(FileBraces);
    expect(fileIconOf("trace.ndjson")).toBe(FileBraces);
    expect(fileIconOf("rules.mdc")).toBe(FileText);
    expect(fileIconOf("spec.pdf")).toBe(FileText);
  });

  it("draws no icon for a path ending in a slash, which names a folder", () => {
    expect(fileIconOf("vendor/nested-repo/")).toBeNull();
  });

  it("reads the last segment of a path, whatever the case of its extension", () => {
    expect(fileIconOf("apps/web/src/map/use-tiles.ts")).toBe(FileCode);
    expect(fileIconOf("docs\\images\\LOGO.PNG")).toBe(FileImage);
    expect(fileIconOf("design/brand/README.md")).toBe(FileText);
  });

  it("falls back to the plain file icon", () => {
    expect(fileIconOf("notes.xyz")).toBe(File);
    expect(fileIconOf("bin")).toBe(File);
    expect(fileIconOf(".hidden")).toBe(File);
    expect(fileIconOf("")).toBe(File);
  });
});
