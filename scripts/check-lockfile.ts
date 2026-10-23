// Fails when package-lock.json lost the entries of bundled dependencies. npm on Windows drops them for platform
// packages it does not install locally (e.g. @tailwindcss/oxide-wasm32-wasi bundles @emnapi/*), and `npm ci` on Linux
// then fails with "Missing: ... from lock file". This only reads the lockfile, so it needs no install and runs first in CI.
// Usage: node scripts/check-lockfile.ts [path/to/package-lock.json]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface LockPackage {
    bundleDependencies?: string[] | boolean;
    bundledDependencies?: string[] | boolean;
    dependencies?: Record<string, string>;
}

export interface Lockfile {
    packages?: Record<string, LockPackage>;
}

export interface CheckLockfileResult {
    code: number;
    stdout: string;
    stderr: string;
}

// Returns the `node_modules/<name>` child paths that a bundled dependency declares but that have no entry of their
// own in `packages`. Empty means the lockfile is complete.
export function findMissingBundledEntries(lock: Lockfile): string[] {
    const packages = lock.packages ?? {};
    const missing: string[] = [];
    for (const [path, pkg] of Object.entries(packages)) {
        if (path === '') continue;
        const declared = pkg.bundleDependencies ?? pkg.bundledDependencies;
        // `true` means "bundle every dependency"; an array names them.
        const names = Array.isArray(declared) ? declared : declared ? Object.keys(pkg.dependencies ?? {}) : [];
        for (const name of names) {
            const childPath = `${path}/node_modules/${name}`;
            if (!(childPath in packages)) missing.push(childPath);
        }
    }
    return missing;
}

// Reads the lockfile at `argv[0]` (defaulting to package-lock.json) and reports any missing bundled entries. Returns
// a result rather than printing and exiting directly, so both the CLI wrapper below and `bin.ts` can run it.
export function checkLockfile(argv: readonly string[]): CheckLockfileResult {
    const lockPath = argv[0] ?? 'package-lock.json';
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lockfile;
    const missing = findMissingBundledEntries(lock);
    if (missing.length > 0) {
        const lines = [
            `${lockPath} is missing ${missing.length} bundled dependency entr${missing.length === 1 ? 'y' : 'ies'}:`,
            ...missing.map((entry) => `  - ${entry}`),
            '',
            `npm on Windows drops these entries, and 'npm ci' on Linux CI then fails with "Missing: ... from lock file".`,
            'Fix: restore the lockfile from main and redo your change on top of it:',
            '    git checkout origin/main -- package-lock.json',
            '    npm install <your change>',
            `then run 'npm run check-lockfile' again. Alternatively, run the install on Linux or WSL.`,
        ];
        return { code: 1, stdout: '', stderr: `${lines.join('\n')}\n` };
    }
    return { code: 0, stdout: `${lockPath}: all bundled dependency entries are present.\n`, stderr: '' };
}

// Only runs when this module is the Node entry point, so the logic above stays testable without process.exit — the
// same split release/cli.ts uses between commands.ts and itself. pathToFileURL (rather than a bare `file://` prefix)
// is needed for this comparison to hold on Windows, where argv paths use backslashes and no leading slash.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { code, stdout, stderr } = checkLockfile(process.argv.slice(2));
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = code;
}
