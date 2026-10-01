<img src="design/brand/begitra-icon.svg" alt="" width="96">

# Begitra

Begitra is a desktop Git client for reading and reviewing large volumes of AI-generated code on
standard Git repositories. It is built with Tauri 2, Rust (`git2`, `rusqlite`) and Vue 3. The name
is "begira", Basque for "look!", with git inside it. The installers are published on
[GitHub Releases](https://github.com/ikerzam/begitra/releases), and the product page is
[begitra.ikerzam.tech](https://begitra.ikerzam.tech).

## Prerequisites

- Node.js 24 and pnpm 11 (`corepack enable` picks the version pinned in `package.json`).
- Rust stable with `clippy` and `rustfmt` (`rustup component add clippy rustfmt`).
- Linux only: the Tauri system packages (`libwebkit2gtk-4.1-dev`, `build-essential`, `curl`,
  `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).

## Commands

| Task | Command |
| --- | --- |
| Install (also installs the git hooks) | `pnpm install` |
| Run the app | `pnpm tauri dev` |
| Frontend tests | `pnpm test` (watch) or `pnpm test:run` |
| Frontend lint, format, types | `pnpm lint`, `pnpm format`, `pnpm typecheck` |
| Frontend build | `pnpm build` |
| Rust tests | `cargo test --workspace --manifest-path src-tauri/Cargo.toml` |
| Rust lint | `cargo clippy --workspace --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings` |
| Rust format | `cargo fmt --all --manifest-path src-tauri/Cargo.toml` |
| Benchmarks | `cargo bench -p bench --manifest-path src-tauri/Cargo.toml` |
| Regenerate the Tailwind theme | `node scripts/generate-tailwind-theme.mjs` (after editing `design/tokens.json`) |
| The engine as JSON, without the window | `cargo build -p begitra-cli --release`, then `target/release/begitra-cli --help` |

## Continuous integration

`.github/workflows/ci.yml` runs when you start it (Actions › CI › "Run workflow") and, on
Windows alone, when `release.yml` calls it for a release, never by itself: on a push it would
repeat the `pre-push` hook, which runs the same suites on Windows. What it adds is the other two platforms: start it
before a release and after a change that touches paths, processes or the filesystem. It has
two jobs:

1. **web** (Ubuntu): `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test:run`,
   `pnpm build`, and the Tailwind theme regenerated from `design/tokens.json` with no diff. The
   frontend is jsdom with the platform faked, so once is enough.
2. **rust** (Ubuntu, Windows, macOS): `cargo fmt --check`, `cargo clippy -D warnings`,
   `cargo test --workspace`, and the IPC fixtures unchanged after the tests. The engine spawns
   git and touches the filesystem, so it runs on the three.

Reading a run: open the **Actions** tab of the repository, pick the run for your commit, then the
job. The steps run in the order above and stop at the first failure, so the failing step is the
first one marked red; expand it to see the same output the command prints locally. A `rust` job
that is red on one operating system only is usually a path, line-ending or system-package problem
for that platform. Re-run a single job from the run page when the failure looks unrelated to the
change.

Four more workflows: `release.yml` publishes a release (below); `packages.yml`, started by hand
from the Actions tab, runs the checks above and builds the installers of the three platforms
without the updater's signatures, keeping them as artifacts of the run; `audit.yml` checks the production npm dependencies and `src-tauri/Cargo.lock` against their
advisories every Monday and on demand (one Ubuntu job of about a minute); and `dependabot.yml`
runs, on Ubuntu, the check each of Dependabot's weekly updates can break (the frontend's for npm,
the engine's for Cargo; the updates of the actions, pinned by commit, run none) and merges a patch
or minor npm or Cargo update that passes it.
A major, an update of the actions and a failing one wait for review.

## Releases

A release is a tag. Bump `version` in `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and
`package.json` (the Rust tests then rewrite the IPC fixtures that carry it), push the version's
title and notes, in English and Spanish, to `releases.json` in
[the site's repository](https://github.com/ikerzam/begitra-site), then push the tag `v<version>`.

`release.yml` checks that the tag, the manifests and the notes agree, runs the checks on Windows,
builds the NSIS and MSI installers, and signs them for the updater in a job of its own: the key is
the secret `TAURI_SIGNING_PRIVATE_KEY` of the environment `release`, which no other job receives.
It verifies each signature against the public key in `tauri.conf.json`, then publishes the GitHub
Release with the installers, their signatures, `latest.json` (what the updater reads) and
`site-facts.json` (what the site's pages read). Started by hand on `main`, it does the same up to
the publishing, and keeps the files as an artifact of the run.

`scripts/release.mjs` holds those steps, so they run the same way on a machine that has the key
in `~/.tauri/begitra.key`:

```bash
pnpm tauri build --bundles nsis msi --config src-tauri/tauri.unsigned.conf.json
node scripts/release.mjs sign --installers src-tauri/target/release/bundle
node scripts/release.mjs stage --releases ../begitra-site/releases.json --installers src-tauri/target/release/bundle --out src-tauri/target/release-files
```

## Git workflow

Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`...); the `commit-msg` hook
rejects other formats. The `pre-commit` hook formats and lints the staged files, and `pre-push`
runs the full Rust and Vitest suites. Set `LEFTHOOK=0` to skip the hooks once when you know what
you are doing.
