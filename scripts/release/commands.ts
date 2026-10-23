import { closeSync, constants, existsSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { nextVersion, releaseKind } from './nextVersion.ts';
import { isTitleError, parseTitle } from './parseTitle.ts';
import type { ParsedTitle } from './parseTitle.ts';
import { buildReleaseNotes, parseMergeLog } from './releaseNotes.ts';
import { resolveVersionConflicts } from './resolveConflicts.ts';
import { shippedChanges } from './shippedPaths.ts';
import { setLockfileVersion, setPackageVersion } from './versionFiles.ts';

export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

const USAGE = `Usage: node scripts/release/cli.ts <command> [options]

Commands:
  check-title <title>                              Fail unless the title is a Conventional Commit.
  expected-version --base-version <v> <title>      Print the version a PR with this title must carry.
  check-shipped --base-package <file> --head-package <file> --changed-files <file>
                --shipped-prefix <prefix> (repeatable) --shipped-file <file> (repeatable) <title>
                                                   Fail if a docs/ci/test title changes shipped inputs. At least one
                                                   of --shipped-prefix or --shipped-file is required.
  write-version <version> [--dir <dir>]            Set the version in package.json and package-lock.json.
  notes --version <v> --log-file <file> [--notes-dir <dir>]
                                                   Print release notes from a first-parent git log.
  resolve-conflicts <file>                         Resolve a merge conflict that is only version lines.
`;

function ok(stdout = ''): CommandResult {
    return { code: 0, stdout, stderr: '' };
}

function fail(stderr: string): CommandResult {
    return { code: 1, stdout: '', stderr: `${stderr}\n` };
}

function parseOrFail(title: string | undefined): ParsedTitle | CommandResult {
    if (title === undefined) return fail('Missing title argument.');
    const parsed = parseTitle(title);
    return isTitleError(parsed) ? fail(parsed.message) : parsed;
}

function isResult(value: ParsedTitle | CommandResult): value is CommandResult {
    return 'code' in value;
}

// Editing a symlinked package.json would let a pull request point the bot at a file outside the checkout, so the
// version files must be regular files. Opening with O_NOFOLLOW and then reading and writing through that one
// descriptor leaves no gap between the check and the edit in which the file could be swapped for a link. Windows has
// no O_NOFOLLOW, so there the path is checked after opening instead; the bot itself only runs on Linux.
function openRegularFile(path: string): number {
    const symlinkError = new Error(`${path} is a symbolic link; refusing to edit it.`);
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
        throw (error as NodeJS.ErrnoException).code === 'ELOOP' ? symlinkError : error;
    }
    if (constants.O_NOFOLLOW === undefined && lstatSync(path).isSymbolicLink()) {
        closeSync(fd);
        throw symlinkError;
    }
    return fd;
}

function overwrite(fd: number, text: string): void {
    ftruncateSync(fd, 0);
    writeSync(fd, text, 0);
}

// Opens every file before calling `edit`, so a link or a missing file fails before anything is written.
function editRegularFiles(paths: readonly string[], edit: (texts: string[]) => string[] | undefined): boolean {
    const fds: number[] = [];
    try {
        for (const path of paths) fds.push(openRegularFile(path));
        const edited = edit(fds.map((fd) => readFileSync(fd, 'utf8')));
        if (edited === undefined) return false;
        fds.forEach((fd, index) => overwrite(fd, edited[index]));
        return true;
    } finally {
        for (const fd of fds) closeSync(fd);
    }
}

function splitLines(text: string): string[] {
    return text.split('\n').filter((line) => line.length > 0);
}

export function runCommand(argv: readonly string[]): CommandResult {
    const [command, ...rest] = argv;
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            'base-version': { type: 'string' },
            'base-package': { type: 'string' },
            'head-package': { type: 'string' },
            'changed-files': { type: 'string' },
            'shipped-prefix': { type: 'string', multiple: true },
            'shipped-file': { type: 'string', multiple: true },
            dir: { type: 'string' },
            version: { type: 'string' },
            'log-file': { type: 'string' },
            'notes-dir': { type: 'string' },
        },
    });

    switch (command) {
        case 'check-title': {
            const parsed = parseOrFail(positionals[0]);
            if (isResult(parsed)) return parsed;
            return ok(`${parsed.type}${parsed.breaking ? ' (breaking)' : ''}\n`);
        }
        case 'expected-version': {
            const parsed = parseOrFail(positionals[0]);
            if (isResult(parsed)) return parsed;
            if (!values['base-version']) return fail('Missing --base-version.');
            return ok(`${nextVersion(values['base-version'], parsed)}\n`);
        }
        case 'check-shipped': {
            const parsed = parseOrFail(positionals[0]);
            if (isResult(parsed)) return parsed;
            const basePath = values['base-package'];
            const headPath = values['head-package'];
            const changedPath = values['changed-files'];
            if (!basePath || !headPath || !changedPath) {
                return fail('Missing --base-package, --head-package or --changed-files.');
            }
            const shippedPrefixes = values['shipped-prefix'] ?? [];
            const shippedFiles = values['shipped-file'] ?? [];
            if (shippedPrefixes.length === 0 && shippedFiles.length === 0) {
                return fail('Missing --shipped-prefix or --shipped-file (at least one of each is required).');
            }
            // Releasing types are allowed to change anything; the version check covers them.
            if (releaseKind(parsed) !== 'none') return ok();
            const reasons = shippedChanges({
                changedFiles: splitLines(readFileSync(changedPath, 'utf8')),
                basePackageJson: readFileSync(basePath, 'utf8'),
                headPackageJson: readFileSync(headPath, 'utf8'),
                shippedPrefixes,
                shippedFiles,
            });
            if (reasons.length === 0) return ok();
            return fail(
                `A "${parsed.type}" title releases nothing, but this PR changes shipped inputs:\n` +
                    reasons.map((reason) => `  - ${reason}`).join('\n') +
                    `\nUse a releasing type instead (feat, fix, perf, refactor, build, chore, revert or style).`,
            );
        }
        case 'write-version': {
            const version = positionals[0];
            if (!version) return fail('Missing version argument.');
            const dir = values.dir ?? '.';
            const packagePath = join(dir, 'package.json');
            const lockPath = join(dir, 'package-lock.json');
            // Both edits are computed before either file is written, so a failure leaves the pair consistent.
            editRegularFiles([packagePath, lockPath], ([packageText, lockText]) => [
                setPackageVersion(packageText, version),
                setLockfileVersion(lockText, version),
            ]);
            return ok(`Set version to ${version}\n`);
        }
        case 'notes': {
            const version = values.version;
            const logPath = values['log-file'];
            if (!version || !logPath) return fail('Missing --version or --log-file.');
            const overridePath = join(values['notes-dir'] ?? '.github/release-notes', `v${version}.md`);
            const override = existsSync(overridePath) ? readFileSync(overridePath, 'utf8') : undefined;
            return ok(buildReleaseNotes(parseMergeLog(readFileSync(logPath, 'utf8')), override));
        }
        case 'resolve-conflicts': {
            const path = positionals[0];
            if (!path) return fail('Missing file argument.');
            const resolved = editRegularFiles([path], ([text]) => {
                const resolution = resolveVersionConflicts(text);
                return resolution.resolved ? [resolution.text] : undefined;
            });
            return resolved ? ok(`Resolved ${path}\n`) : fail(`${path} has conflicts beyond the version line.`);
        }
        default:
            // No command is a plain request for help; an unknown one is a mistake in the calling workflow.
            return { code: command === undefined ? 0 : 2, stdout: '', stderr: USAGE };
    }
}
