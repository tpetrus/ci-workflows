# ci-workflows

A shared, reusable CI/CD pipeline for my own projects — mostly Cloudflare Workers apps (static SPAs and similar)
built with TypeScript, Vitest, Playwright, Lighthouse CI and size-limit. It is composite GitHub Actions, reusable
GitHub Actions workflows, and a small Node CLI, `ci-tools` (release automation and a lockfile check). A caller gets all of
it by referencing a handful of thin workflow files; the logic itself lives here, in one place.

## What's in here

Composite actions (`actions/*/action.yml`):

| Action | What it does |
|---|---|
| `setup` | Checks out the caller's repository, sets up Node from `.nvmrc`, checks the lockfile, runs `npm ci`. |
| `check-lockfile` | Fails if the lockfile is missing bundled dependency entries that npm on Windows drops. Standalone: brings its own Node setup. |
| `release-cli` | Runs one `scripts/release/cli.ts` subcommand from this repo against the caller's checkout. |

Reusable workflows (`.github/workflows/*.yml`):

| Workflow | What it does |
|---|---|
| `node-ci.yml` | Builds once, then runs quality (format/lint/typecheck/coverage), a max-file-size check, and optional bundle-size, Lighthouse, Playwright e2e (auto-sharded) and broken-link jobs. One aggregator job (`result`) is the single required check. |
| `pr-checks.yml` | Two PR checks: `pr-title` (the title is a Conventional Commit) and `version` (`package.json`/`package-lock.json` carry the version that title calls for). |
| `version-bump.yml` | The version bot: sets a PR branch's version to match its title, and keeps every open PR in sync when `main` moves. Authenticates as a GitHub App. |
| `release.yml` | Tags and publishes a GitHub Release whenever `main` carries a version with no tag yet. |
| `security.yml` | `npm audit` (production dependencies block, dev dependencies are informational), GitHub's dependency review on PRs, and a `zizmor` scan of the caller's own workflows. |
| `codeql.yml` | CodeQL static analysis of JavaScript/TypeScript and of the workflow files themselves. |
| `smoke.yml` | Runs the caller's `@smoke` Playwright tests against a live URL. Never deploys; only reports. |
| `update-snapshots.yml` | Regenerates Playwright visual-regression baselines and commits them back to the given ref. |

## The `ci-tools` CLI

The TypeScript sources in `scripts/` are run in two different ways:

- **Directly as `.ts`**, by the composite actions, `npm run check-lockfile` / `npm run release` and the specs. Node 24
  strips the types itself, so none of these needs a build.
- **As built JavaScript**, by the `ci-tools` bin, for example
  `npx --yes github:tpetrus/ci-workflows#v1 ci-tools check-lockfile`. npx installs the package under a
  `node_modules` directory, and Node refuses to strip types from `.ts` files there
  (see [Type stripping in dependencies](https://nodejs.org/api/typescript.html#type-stripping-in-dependencies)),
  so the bin points at `dist/bin.js`, emitted by `npm run build` (`tsc -p tsconfig.build.json`). `dist/` is not
  committed: the `prepare` script builds it, and npm runs `prepare` both for `npm pack` and when installing from a
  git spec. `npm run verify:pack` (run in `self-ci.yml` on Linux and Windows) packs the repo, installs the tarball
  into a throwaway project and runs the bin from there, so a regression back to `.ts` fails CI.

## The caller contract

To use `node-ci.yml` (the core pipeline), a caller repo needs:

- a `.nvmrc` pinning its Node version (read via `node-version-file`)
- npm scripts named `format:check`, `lint`, `typecheck`, `test:coverage` and `build` — required
- npm scripts named `size`, `lighthouse` and `test:smoke` — only if those optional jobs/workflows are turned on

Playwright, Lighthouse CI and size-limit configs (`playwright.config.ts`, `lighthouserc.json`, `.size-limit.json`)
stay in the caller's own repo. This repo only orchestrates them; it doesn't own or ship those configs.

## Example

A caller references this repo's workflows with
`uses: tpetrus/ci-workflows/.github/workflows/<name>.yml@<sha> # <version>` — see
[Versioning](#versioning) below for why a SHA, not `@v1`, is what actually goes in a `uses:` line. These three
examples are adapted from this repo's own `self-pr-checks.yml` and `self-release.yml` (which call `@main` since
they dogfood this repo against itself), plus a `node-ci.yml` caller built from that workflow's own declared
inputs — generalized here for a typical caller instead of a self-reference. Replace `<sha>` in each example below
with the real commit SHA for the version you're pinning to (see [Versioning](#versioning)); these examples use a
placeholder since no fixed SHA stays accurate as this repo releases new versions.

```yaml
# .github/workflows/ci.yml
name: Node CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  ci:
    uses: tpetrus/ci-workflows/.github/workflows/node-ci.yml@<sha> # v1.2.3
    with:
      build-dir: build/client
      max-file-size: 5MB
```

```yaml
# .github/workflows/pr-checks.yml
name: PR checks

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read

concurrency:
  group: pr-checks-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  pr-checks:
    uses: tpetrus/ci-workflows/.github/workflows/pr-checks.yml@<sha> # v1.2.3
    with:
      shipped-prefixes: |
        src/
        public/
      shipped-files: |
        package.json
```

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    branches: [main]

permissions: {}

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  release:
    permissions:
      contents: write
    uses: tpetrus/ci-workflows/.github/workflows/release.yml@<sha> # v1.2.3
```

## Versioning

`v0.1.0`, `v0.1.1`, and so on are the real semver tags, cut from this repo's own dogfooded `self-release.yml`.
`v1`, `v2`, ... are floating major-alias tags: `v1` moves forward onto every new backward-compatible release, and a
breaking change gets a new major (`v2`) instead of moving `v1` onto it. They're a resolution anchor for finding
"what to pin to next," not something to write directly into a `uses:` line.

Pin a caller's `uses:` line to a commit SHA with a trailing version comment, the same convention this repo already
uses for every third-party action it depends on:

```yaml
uses: tpetrus/ci-workflows/.github/workflows/<name>.yml@<sha> # v1.2.3
```

not `@v1` directly, and not `@main` (tracks unreleased work on this repo). A floating tag — even a major alias —
fails zizmor's/CodeQL's `unpinned-uses`/`unpinned-tag` check, since it can move to different code without the
caller's `uses:` line changing; a bare commit SHA with no trailing comment is the same risk in the other direction
(nothing records which release it came from, so nothing prompts you to look for a newer one). SHA-pinning with a
version comment satisfies the scanner and keeps the version visible.

To find `<sha>` for a given release, resolve the tag once (e.g.
`gh api repos/tpetrus/ci-workflows/commits/v1.2.3 --jq .sha`, or `git rev-parse v1.2.3` against a local clone) and
pin to that SHA directly; do not re-resolve `v1` on every run.

SHA-pinning alone would otherwise mean manually bumping every caller by hand to pick up a fix. To keep that
near-zero effort, add this repo's reusable workflows to the caller's own `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Dependabot already understands SHA-pinned actions and reusable workflows generically, including ones with a
trailing version comment like the one above: it resolves the pin back to the tag it matches, checks for a newer
tag, and opens a PR that updates both the SHA and the comment. No special-casing of this repo is needed in the
caller's `dependabot.yml` beyond the generic `github-actions` ecosystem entry.

`@main` remains reserved for this repo's own internal self-references (the four `self-*.yml` files, which
deliberately dogfood unreleased HEAD against itself) — unaffected by this change, and still correctly
zizmor-suppressed there with an inline `unpinned-uses` ignore and explanatory comment.

## One-time setup for `version-bump`/`release`

A caller that wants the automated-semver-from-PR-title system (`version-bump.yml` + `release.yml`) needs to:

1. Install the GitHub App used for this (the same one already installed elsewhere, or a new one) on the caller's
   repo.
2. Add `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` as secrets in both Settings → Secrets → Actions and
   Settings → Secrets → Dependabot (Dependabot-triggered runs only read the latter).
3. Require the `pr-title` and `version` checks (from `pr-checks.yml`), plus `node-ci.yml`'s `result` aggregator job,
   in the repo's branch ruleset.

## Security posture

Every workflow and action here is scanned by `actionlint` and `zizmor` on every change (see `self-ci.yml`);
third-party actions are pinned by commit SHA; untrusted event data (PR titles, branch names, etc.) is always routed
through environment variables and step outputs, never interpolated directly into a shell script.

## License

[MIT](LICENSE)
