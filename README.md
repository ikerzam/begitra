<img src="design/brand/begitra-icon.svg" alt="" width="96">

# Begitra

Begitra is a desktop Git client for reading and reviewing large volumes of AI-generated code on
standard Git repositories. It is built with Tauri 2, Rust (`git2`, `rusqlite`) and Vue 3. The name
is "begira", Basque for "look!", with git inside it. Downloads and release notes are at
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

`.github/workflows/ci.yml` runs when you start it (Actions › CI › "Run workflow") and when
`release.yml` calls it on a tag, never by itself: on a push it would repeat the `pre-push`
hook, which runs the same suites on Windows. What it adds is the other two platforms: start it
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

Three more workflows: `release.yml`, started by hand from the Actions tab, runs the checks above
and builds the installers without releasing them, keeping them as artifacts of the run (a release
is built on Windows with `scripts/release.mjs` and published to the release site);
`audit.yml` checks the production npm dependencies and `src-tauri/Cargo.lock` against their
advisories every Monday and on demand (one Ubuntu job of about a minute); and `dependabot.yml`
runs, on Ubuntu, the check each of Dependabot's weekly updates can break (the frontend's for npm,
the engine's for Cargo; the updates of the actions, pinned by commit, run none) and merges a patch
or minor npm or Cargo update that passes it.
A major, an update of the actions and a failing one wait for review.

## Git workflow

Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`...); the `commit-msg` hook
rejects other formats. The `pre-commit` hook formats and lints the staged files, and `pre-push`
runs the full Rust and Vitest suites. Set `LEFTHOOK=0` to skip the hooks once when you know what
you are doing.
