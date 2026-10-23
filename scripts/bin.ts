#!/usr/bin/env node
// Dispatches to the sub-tools in this repo, so it can be run via `npx github:tpetrus/ci-workflows#v1 <command>`
// (through the `ci-tools` bin in package.json). The logic lives in check-lockfile.ts and release/commands.ts; this
// file only does process I/O, the same split release/cli.ts uses for the release sub-tool alone.
import { checkLockfile } from './check-lockfile.ts';
import { runCommand } from './release/commands.ts';

const USAGE = `Usage: ci-tools <sub-tool> [args]

Sub-tools:
  check-lockfile [path/to/package-lock.json]   Fail if the lockfile is missing bundled dependency entries.
  release <command> [options]                  Run a release command (node scripts/release/cli.ts with no
                                                 arguments prints its own usage).
`;

const [subTool, ...rest] = process.argv.slice(2);

const { code, stdout, stderr } =
    subTool === 'check-lockfile'
        ? checkLockfile(rest)
        : subTool === 'release'
          ? runCommand(rest)
          // No sub-tool is a plain request for help; an unknown one is a mistake in the caller.
          : { code: subTool === undefined ? 0 : 2, stdout: '', stderr: USAGE };

process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
