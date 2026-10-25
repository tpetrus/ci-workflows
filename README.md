# ci-workflows

A shared, reusable CI/CD pipeline for my own projects — mostly Cloudflare Workers apps (static SPAs and similar)
built with TypeScript, Vitest, Playwright, Lighthouse CI and size-limit. It is composite GitHub Actions, reusable
GitHub Actions workflows, and a small Node CLI, `ci-tools` (release automation, a lockfile check and a lockfile repair). A caller gets all of
it by referencing a handful of thin workflow files; the logic itself lives here, in one place.

## What's in here

Composite actions (`actions/*/action.yml`):

| Action | What it does |
|---|---|
| `setup` | Checks out the caller's repository, sets up Node from `.nvmrc`, checks the lockfile, runs `npm ci`. |
| `check-lockfile` | Fails if the lockfile is missing bundled dependency entries that npm on Windows drops. Standalone: brings its own Node setup. |
| `repair-lockfile` | Adds back the bundled-dependency entries that `check-lockfile` reports missing, without running npm. Exit code 1 (could not repair) is a warning, not a failure. |
| `release-cli` | Runs one `scripts/release/cli.ts` subcommand from this repo against the caller's checkout. |

Reusable workflows (`.github/workflows/*.yml`):

| Workflow | What it does |
|---|---|
| `node-ci.yml` | Builds once, then runs quality (format/lint/typecheck/coverage), a max-file-size check, and optional bundle-size, Lighthouse, Playwright e2e (auto-sharded) and broken-link jobs. One aggregator job (`result`) is the single required check. |
| `pr-checks.yml` | Two PR checks: `pr-title` (the title is a Conventional Commit) and `version` (`package.json`/`package-lock.json` carry the version that title calls for). |
| `version-bump.yml` | The version bot: sets a PR branch's version to match its title, and keeps every open PR in sync when `main` moves. On a PR it also repairs a lockfile that lost bundled-dependency entries (see [Lockfile repair](#lockfile-repair)). Authenticates as a GitHub App. |
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
  `npx --yes github:tpetrus/ci-workflows#v1.2.3 check-lockfile`. The package has a single bin, so npx runs it
  directly and the sub-tool follows the package spec (repeating `ci-tools` there is passed through as an unknown
  sub-tool and prints usage; `npx --package=github:tpetrus/ci-workflows#v1.2.3 ci-tools ...` is the explicit form).
  Always use an exact `#vX.Y.Z` release tag in the ref (see [Versioning](#versioning)), never `#v1` or `#main`.
  npx installs the package under a
  `node_modules` directory, and Node refuses to strip types from `.ts` files there
  (see [Type stripping in dependencies](https://nodejs.org/api/typescript.html#type-stripping-in-dependencies)),
  so the bin points at `dist/bin.js`, emitted by `npm run build` (`tsc -p tsconfig.build.json`). `dist/` is not
  committed: the `prepare` script builds it, and npm runs `prepare` both for `npm pack` and when installing from a
  git spec. `npm run verify:pack` (run in `self-ci.yml` on Linux and Windows) packs the repo, installs the tarball
  into a throwaway project and runs the bin from there, so a regression back to `.ts` fails CI.

A `package.json` script that runs the CLI through npx carries its own `#vX.Y.Z` ref. Dependabot does not update that
ref: it only sees `uses:` lines, not npx specs inside a script. Until the CLI is published to a registry, bump it by
hand in the same change that bumps the `uses:` refs to the same release.

### Lockfile repair

`check-lockfile` reports, and `repair-lockfile` fixes, a `package-lock.json` that lost the entries of bundled
dependencies. The cause is in npm: it learns what a package bundles only by unpacking the package's tarball, and a
bundler that is inert on the current platform (for example `@tailwindcss/oxide-wasm32-wasi`, `cpu: ["wasm32"]`) is never
unpacked, so a plain `npm install` on Windows or macOS writes no entries for its bundled children and `npm ci` on Linux
fails with "Missing: ... from lock file" (npm/cli#9321, tailwindlabs/tailwindcss#20324). There is no `.npmrc` setting
that avoids it, and `npm install --package-lock-only` fixes it only on some npm versions and rewrites unrelated entries.

```
npx --yes --package=github:tpetrus/ci-workflows#vX.Y.Z ci-tools repair-lockfile [path/to/package-lock.json]
```

It downloads each affected bundler's tarball from `https://registry.npmjs.org/` (the `resolved` URL must be exactly
that origin, with no redirects), refuses it unless its sha512 matches the lockfile's `integrity`, reads the bundled
`package.json` files in memory (nothing is extracted or executed) and inserts the missing entries the way npm writes them,
with the same key order and the file's own indentation and line endings. Existing entries are never changed. If anything
cannot be repaired it writes nothing and exits 1; exit 0 means repaired or nothing to do.

**The version bot does this for you.** On every same-repo PR (Dependabot's included, which is where a Tailwind bump
arrives) `version-bump.yml` runs the `repair-lockfile` action against the PR's lockfile and, if it changed, commits only
that file as `chore: repair package-lock.json for Linux`, in the same push as the version commit when both are needed.
If the repair fails it logs a warning and carries on; `check-lockfile` in CI still fails the PR. This is safe under
`pull_request_target` (see GitHub Security Lab's
[preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)) because the
script is this repo's, at the workflow's own commit, and the PR's lockfile is only parsed as JSON: no npm, no lifecycle
script, no file from the PR is executed, and the token is not passed to it.

## The caller contract

To use `node-ci.yml` (the core pipeline), a caller repo needs:

- a `.nvmrc` pinning its Node version (read via `node-version-file`)
- npm scripts named `format:check`, `lint`, `typecheck`, `test:coverage` and `build` — required
- npm scripts named `size`, `lighthouse` and `test:smoke` — only if those optional jobs/workflows are turned on

Playwright, Lighthouse CI and size-limit configs (`playwright.config.ts`, `lighthouserc.json`, `.size-limit.json`)
stay in the caller's own repo. This repo only orchestrates them; it doesn't own or ship those configs.

## Example

A caller references this repo's workflows with
`uses: tpetrus/ci-workflows/.github/workflows/<name>.yml@vX.Y.Z`, an exact release tag; see
[Versioning](#versioning) below. These three examples are adapted from this repo's own `self-pr-checks.yml` and
`self-release.yml` (which call `@main` since they dogfood this repo against itself), plus a `node-ci.yml` caller built
from that workflow's own declared inputs, generalized here for a typical caller instead of a self-reference. Replace
`v1.2.3` in each example with the release you're pinning to; no fixed tag stays current as this repo releases new
versions.

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
    uses: tpetrus/ci-workflows/.github/workflows/node-ci.yml@v1.2.3
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
    uses: tpetrus/ci-workflows/.github/workflows/pr-checks.yml@v1.2.3
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
    uses: tpetrus/ci-workflows/.github/workflows/release.yml@v1.2.3
```

## Versioning

Releases are cut from this repo's own dogfooded `self-release.yml` as exact semver tags (`v0.1.4`, ...). Callers pin
to one of them:

```yaml
uses: tpetrus/ci-workflows/.github/workflows/<name>.yml@v1.2.3
```

- **Tags are never moved.** Nobody re-points a tag, so a given `@vX.Y.Z` always runs the same workflow file.
- **Releases are immutable** from the first release cut after immutable releases were enabled on this repo
  (`v0.1.4` onward): GitHub then locks the release's tag and assets against edits and deletion. `v0.1.0` through
  `v0.1.3` predate that setting and stay mutable; they were not republished.
- **`v1` is a legacy tag**, kept only so old references to it don't break. It is not maintained, does not move and is
  not something to pin to. Do not use `@v1` or `@main` (unreleased work) in a caller.
- Third-party actions stay pinned by commit SHA with a trailing version comment; only this repo's own refs use tags.

### Keeping callers current

Add the `github-actions` ecosystem to the caller's `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Dependabot bumps exact-tag reusable-workflow refs. It only considers tags with the same precision as the pinned ref
(`tags_matching_pinned_precision` in dependabot-core's `github_actions/.../latest_version_finder.rb`), so `@v0.1.3`
moves to `v0.1.4` and the two-part `v1` is ignored. A bump PR changes the `uses:` refs only; also bump any npx ref in
a `package.json` script by hand (see [The `ci-tools` CLI](#the-ci-tools-cli)).

### Scanner configuration in the caller

zizmor's default `unpinned-uses` policy wants a commit hash for everything, so a tag ref to this repo is flagged.
Allow ref-pins for this repo and keep hash-pins for everyone else in the caller's `.github/zizmor.yml`:

```yaml
rules:
  unpinned-uses:
    config:
      policies:
        "tpetrus/*": ref-pin
        "*": hash-pin
```

The shared `security.yml` zizmor job runs `zizmor .github/` in the caller's checkout, so the caller's
`.github/zizmor.yml` is discovered automatically.

CodeQL's `actions/unpinned-tag` query (in the security-extended suite) will still raise medium-severity alerts for
these refs: its only trusted owners are `actions`, `github` and `advanced-security`. Dismiss them in the caller as
accepted risk (the tags are immutable releases of a first-party repo), or exclude the query.

## One-time setup for `version-bump`/`release`

A caller that wants the automated-semver-from-PR-title system (`version-bump.yml` + `release.yml`) needs to:

1. Install the GitHub App used for this (the same one already installed elsewhere, or a new one) on the caller's
   repo, with these repository permissions:
   - **Contents: Read and write** (both `version-bump.yml` jobs push commits).
   - **Pull requests: Read** (the `sync-prs` job lists each branch's open pull request).
   - **Issues: Read and write** (the `sync-prs` job posts its conflict notice through the issues comment endpoint).

   `sync-prs` requests all three for its token, and GitHub rejects a token request for a permission the installation
   lacks: `The permissions requested are not granted to this installation.` Add Issues to the App, then accept the
   updated permissions on each installation.
2. Add `RELEASE_APP_ID` (the App's numeric ID; the workflow passes it to `create-github-app-token`'s `client-id` input, which
   hands the value to the same `appId` option the deprecated `app-id` input used) and `RELEASE_APP_PRIVATE_KEY` as secrets in both Settings → Secrets → Actions and
   Settings → Secrets → Dependabot (Dependabot-triggered runs only read the latter).
3. Require the `pr-title` and `version` checks (from `pr-checks.yml`), plus `node-ci.yml`'s `result` aggregator job,
   in the repo's branch ruleset.

## Security posture

Every workflow and action here is scanned by `actionlint` and `zizmor` on every change (see `self-ci.yml`);
third-party actions are pinned by commit SHA; untrusted event data (PR titles, branch names, etc.) is always routed
through environment variables and step outputs, never interpolated directly into a shell script.

This repo's workflows reference its own composite actions with GitHub's self repository reference
(`uses: $/actions/setup`, [docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)),
which resolves at the commit of the workflow file using it. A caller pinned to `@vX.Y.Z` therefore runs that release's
actions, not whatever is on `main`. It is not available on GitHub Enterprise Server. actionlint (1.7.12, the latest
release) cannot parse it yet, so `self-ci.yml` ignores exactly that message.

`codeql.yml` excludes the `actions/unpinned-tag` query: zizmor's `unpinned-uses` audit (in `security.yml`) is the single
pinning gate, since CodeQL's rule would flag the exact-tag pins of `tpetrus/*` workflows that this policy allows.
`actions/unpinned-tag` alerts already open in a caller close on the caller's next CodeQL analysis.

zizmor is pinned to an exact version in `security.yml` and `self-ci.yml` (`pipx run zizmor==X.Y.Z`). Dependabot cannot
track a version inside a `run:` string, so bump it deliberately in both files: read the release notes for new or
changed audits, and prefer a release that has been out for at least two weeks.

## License

[MIT](LICENSE)
