# Begira

Begira is a desktop Git client for reading and reviewing large volumes of AI-generated code on
standard Git repositories. It is built with Tauri 2, Rust (`git2`, `rusqlite`) and Vue 3.


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
| The engine as JSON, without the window | `cargo build -p begira-cli --release`, then `target/release/begira-cli --help` |

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request, in two jobs:

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

Two more workflows: `release.yml` builds the installers on a `v*` tag (running the checks above
first) or, started by hand from the Actions tab, builds them without releasing and keeps them as
artifacts of the run; `audit.yml` checks the
production npm dependencies and `src-tauri/Cargo.lock` against their advisories every Monday, on
demand and whenever a lockfile changes. Dependabot opens the weekly dependency updates, including
the actions themselves, which are pinned by commit.

## Git workflow

Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`...); the `commit-msg` hook
rejects other formats. The `pre-commit` hook formats and lints the staged files, and `pre-push`
runs the full Rust and Vitest suites. Set `LEFTHOOK=0` to skip the hooks once when you know what
you are doing.
