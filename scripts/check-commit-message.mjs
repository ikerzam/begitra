#!/usr/bin/env node
// commit-msg hook: enforce Conventional Commits on the subject line.
// Usage: node scripts/check-commit-message.mjs <path-to-COMMIT_EDITMSG>

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) process.exit(0);

const subject = readFileSync(file, "utf8")
  .split(/\r?\n/)
  .find((line) => line.trim() && !line.startsWith("#"));

const pattern =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9-]*\))?!?: [^\s].{0,71}$/;

if (!subject || !pattern.test(subject)) {
  console.error(
    [
      "Commit message must follow Conventional Commits:",
      "  <type>(<scope>)?: <subject>   (subject 72 chars max)",
      "  types: feat fix docs style refactor perf test build ci chore revert",
      `Got: ${subject ?? "(empty)"}`,
    ].join("\n"),
  );
  process.exit(1);
}
