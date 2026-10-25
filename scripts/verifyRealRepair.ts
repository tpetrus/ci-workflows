// Opt-in, network-dependent check of repair-lockfile against a real npm-written lockfile: it removes every bundled
// child entry from a copy of the lockfile, repairs the copy from the real registry tarballs, and requires the result to
// be byte-identical to the original. Not part of `npm test` (which is offline) or CI.
// Usage: npm run verify:repair -- path/to/package-lock.json
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBundlersWithMissingEntries } from './check-lockfile.ts';
import type { Lockfile } from './check-lockfile.ts';
import { repairLockfile } from './repair-lockfile.ts';

const source = process.argv[2];
if (source === undefined) {
    console.error('Usage: npm run verify:repair -- path/to/package-lock.json');
    process.exit(2);
}

const original = readFileSync(source, 'utf8');
const lock = JSON.parse(original) as Lockfile;
if (findBundlersWithMissingEntries(lock).size > 0) {
    console.error(`${source} is already missing bundled entries; use a complete lockfile as the reference.`);
    process.exit(2);
}

const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '  ';
const serialize = (value: Lockfile): string => `${JSON.stringify(value, null, indent)}${original.endsWith('\n') ? '\n' : ''}`;
// A reference that does not survive a parse and re-serialize (e.g. one with a duplicate key) could never compare equal.
if (serialize(lock) !== original) {
    console.error(`${source} does not round-trip through JSON.parse/stringify (a duplicate key or unusual formatting?), so it cannot serve as a reference.`);
    process.exit(2);
}

// Every entry npm marks `inBundle` is a bundled child, so removing exactly those reproduces the broken state.
const packages = lock.packages ?? {};
const removed = Object.keys(packages).filter((path) => packages[path]?.inBundle === true);
for (const path of removed) delete packages[path];
if (removed.length === 0) {
    console.error(`${source} has no inBundle entries, so there is nothing to test against.`);
    process.exit(2);
}
const broken = serialize(lock);

const dir = mkdtempSync(join(tmpdir(), 'verify-repair-'));
try {
    const copy = join(dir, 'package-lock.json');
    writeFileSync(copy, broken);
    console.log(`Removed ${removed.length} bundled entr${removed.length === 1 ? 'y' : 'ies'} from a copy of ${source}:`);
    for (const path of removed) console.log(`  - ${path}`);

    const result = await repairLockfile([copy]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const identical = result.code === 0 && readFileSync(copy, 'utf8') === original;
    console.log(identical ? 'PASS: the repaired lockfile is byte-identical to the original.' : 'FAIL: the repaired lockfile differs from the original.');
    process.exitCode = identical ? 0 : 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
