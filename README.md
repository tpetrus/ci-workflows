# ci-workflows

A shared, reusable CI/CD pipeline for my own projects — mostly Cloudflare Workers apps (static SPAs and similar)
built with TypeScript, Vitest, Playwright, Lighthouse CI and size-limit. It is composite GitHub Actions, reusable
GitHub Actions workflows, and two Node CLI scripts (release automation and a lockfile check). A caller gets all of
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

## The caller contract

To use `node-ci.yml` (the core pipeline), a caller repo needs:

- a `.nvmrc` pinning its Node version (read via `node-version-file`)
- npm scripts named `format:check`, `lint`, `typecheck`, `test:coverage` and `build` — required
- npm scripts named `size`, `lighthouse` and `test:smoke` — only if those optional jobs/workflows are turned on

Playwright, Lighthouse CI and size-limit configs (`playwright.config.ts`, `lighthouserc.json`, `.size-limit.json`)
stay in the caller's own repo. This repo only orchestrates them; it doesn't own or ship those configs.

## Example

A caller references this repo's workflows with `uses: tpetrus/ci-workflows/.github/workflows/<name>.yml@v1`. These
three examples are adapted from this repo's own `self-pr-checks.yml` and `self-release.yml` (which call `@main`
since they dogfood this repo against itself), plus a `node-ci.yml` caller built from that workflow's own declared
inputs — generalized here for a typical caller instead of a self-reference.

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
    uses: tpetrus/ci-workflows/.github/workflows/node-ci.yml@v1
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
    uses: tpetrus/ci-workflows/.github/workflows/pr-checks.yml@v1
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
    uses: tpetrus/ci-workflows/.github/workflows/release.yml@v1
```

## Versioning

`v1` is a floating major tag that this repo moves forward itself (via its own dogfooded `self-release.yml`) as long
as changes stay backward-compatible. A breaking change gets a new major (`v2`) instead of moving `v1` onto it.

Pin to `@v1`, not `@main` (tracks unreleased work on this repo) and not a bare commit SHA (never gets fixes).
`v0.1.0`, `v0.1.1`, and so on are the real semver tags; `v1`, `v2`, ... are aliases that move.

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
