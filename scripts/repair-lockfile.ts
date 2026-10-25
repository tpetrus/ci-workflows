// Repairs a package-lock.json that lost the entries of bundled dependencies (the problem check-lockfile.ts detects),
// without running npm. Usage: node scripts/repair-lockfile.ts [path/to/package-lock.json]
//
// Root cause: npm only learns what a package bundles by unpacking that package's tarball, and a bundler that is inert on
// the current platform (e.g. @tailwindcss/oxide-wasm32-wasi, `cpu: ["wasm32"]`) is never unpacked, so a plain
// `npm install` writes no entries for its bundled children and `npm ci` on Linux then fails with "Missing: ... from lock
// file". See npm/cli#9321 and tailwindlabs/tailwindcss#20324.
//
// What this does instead, as pure data handling:
//  1. Finds every bundler with missing children (check-lockfile.ts's detection).
//  2. Downloads the bundler's `resolved` tarball, only from https://registry.npmjs.org/, and checks its sha512
//     `integrity` BEFORE anything is parsed.
//  3. Reads the bundled packages' package.json files from the tarball in memory (tarball.ts) and builds lockfile
//     entries the way npm's Shrinkwrap.metaFromNode does.
//  4. Adds only the missing keys; existing entries are never modified or removed.
// It never runs npm or any code from the lockfile's project or from the downloaded package, and the registry fetch is
// its only network access. That is what lets the version bot run it against a pull request's lockfile (see
// version-bump.yml).
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findBundlersWithMissingEntries } from './check-lockfile.ts';
import type { CheckLockfileResult, LockPackage, Lockfile } from './check-lockfile.ts';
import { DEFAULT_TAR_LIMITS, TarballError, readBundledManifests } from './tarball.ts';
import type { TarLimits } from './tarball.ts';

export type FetchTarball = (url: string, maxBytes: number) => Promise<Buffer>;

// A problem that must stop the repair and leave the lockfile untouched (as opposed to a bundler that is merely skipped).
export class RepairError extends Error {}

// The package.json fields npm copies into a lockfile entry. Mirrors `pkgMetaKeys` in
// @npmcli/arborist lib/shrinkwrap.js (arborist 10.0.4, which npm 11.21 and 12 ship; `libc` is absent from the 9.1.6
// that npm 11.6.2 ships). `_integrity` is handled separately because it is written as `integrity`.
const PACKAGE_META_KEYS = [
    'version',
    'dependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'optionalDependencies',
    'bundleDependencies',
    'acceptDependencies',
    'funding',
    'engines',
    'os',
    'cpu',
    'libc',
    'license',
    'hasInstallScript',
    'bin',
    'deprecated',
    'workspaces',
] as const;

// The flags a bundled child inherits from its bundler: it is reachable only through the bundler, so it is exactly as
// dev/optional/peer as the bundler is.
const INHERITED_FLAGS = ['dev', 'optional', 'peer', 'devOptional'] as const;

// Same key order as json-stringify-nice, which npm serializes lockfiles with: these keys first, in this order
// (`swKeyOrder` in arborist lib/shrinkwrap.js), then everything else alphabetically by `localeCompare(…, 'en')`, with
// every non-object value (scalars and arrays) before every object value.
const PREFERRED_KEY_ORDER = ['name', 'version', 'lockfileVersion', 'resolved', 'integrity', 'requires', 'packages', 'dependencies'];

const compareKeys = (a: string, b: string): number => {
    const aPreferred = PREFERRED_KEY_ORDER.indexOf(a);
    const bPreferred = PREFERRED_KEY_ORDER.indexOf(b);
    if (aPreferred !== -1 && bPreferred !== -1) return aPreferred - bPreferred;
    if (aPreferred !== -1) return -1;
    if (bPreferred !== -1) return 1;
    return a.localeCompare(b, 'en');
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Returns a copy of `value` with every object's keys in npm's lockfile order (json-stringify-nice's `sort`).
export function sortLikeNpm(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortLikeNpm);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([aKey, aValue], [bKey, bValue]) => {
                if (isPlainObject(aValue) === isPlainObject(bValue)) return compareKeys(aKey, bKey);
                return isPlainObject(aValue) ? 1 : -1;
            })
            .map(([key, child]) => [key, sortLikeNpm(child)]),
    );
}

// `https://registry.npmjs.org/...` over https, with no credentials and the default port. Anything else is never fetched.
export function isRegistryTarballUrl(resolved: unknown): resolved is string {
    if (typeof resolved !== 'string') return false;
    let url: URL;
    try {
        url = new URL(resolved);
    } catch {
        return false;
    }
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && url.port === '' && url.username === '' && url.password === '';
}

// Only sha512 is accepted (what npm has written for years). False means there is nothing to verify a tarball against.
export function hasVerifiableIntegrity(integrity: unknown): integrity is string {
    return typeof integrity === 'string' && integrity.split(/\s+/).some((token) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(token));
}

// Throws unless the tarball matches the lockfile's SRI string. An SRI string with several hashes passes if any sha512
// one matches.
export function verifyIntegrity(tarball: Buffer, integrity: string, description: string): void {
    const actual = createHash('sha512').update(tarball).digest();
    const matches = integrity
        .split(/\s+/)
        .filter((token) => token.startsWith('sha512-'))
        .some((token) => {
            const expected = Buffer.from(token.slice('sha512-'.length), 'base64');
            return expected.length === actual.length && timingSafeEqual(expected, actual);
        });
    if (!matches) throw new RepairError(`${description}: the downloaded tarball does not match the lockfile's integrity.`);
}

const hasInstallScripts = (scripts: unknown): boolean =>
    isPlainObject(scripts) && ['install', 'preinstall', 'postinstall'].some((name) => name in scripts);

// npm reads `bin` through its package.json normalizer, which turns the string form into `{ <unscoped name>: path }`.
const normalizeBin = (name: string, bin: unknown): unknown =>
    typeof bin === 'string' ? { [name.replace(/^@[^/]+\//, '')]: bin } : bin;

// Mirrors `metaFieldFromPkg`: a license object contributes only its `type`, and empty or falsy values are dropped.
function metaField(manifest: Record<string, unknown>, key: string): unknown {
    const value = manifest[key];
    if (!value) return undefined;
    if (key === 'license' && isPlainObject(value) && typeof value.type === 'string') return value.type;
    if (typeof value !== 'object' || Object.keys(value).length > 0) return value;
    return undefined;
}

// Builds the lockfile entry npm would write for a bundled child (`Shrinkwrap.metaFromNode`). `bundler` supplies the
// inherited flags.
export function lockEntryFromManifest(manifest: Record<string, unknown>, bundler: LockPackage): LockPackage {
    const name = typeof manifest.name === 'string' ? manifest.name : '';
    const normalized = { ...manifest };
    // package.json spells the field either way; npm normalizes both to `bundleDependencies`, and `true` to the names.
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
    if (bundled === true) normalized.bundleDependencies = Object.keys(isPlainObject(manifest.dependencies) ? manifest.dependencies : {});
    else if (bundled !== undefined) normalized.bundleDependencies = bundled;
    normalized.bin = normalizeBin(name, manifest.bin);
    normalized.hasInstallScript = manifest.hasInstallScript === true || hasInstallScripts(manifest.scripts);

    const entry: Record<string, unknown> = {};
    for (const key of PACKAGE_META_KEYS) {
        const value = metaField(normalized, key);
        if (value !== undefined) entry[key] = value;
    }
    if (typeof manifest._integrity === 'string') entry.integrity = manifest._integrity;
    if (typeof manifest._resolved === 'string') entry.resolved = manifest._resolved;
    entry.inBundle = true;
    for (const flag of INHERITED_FLAGS) {
        if (bundler[flag]) entry[flag] = true;
    }
    return sortLikeNpm(entry) as LockPackage;
}

// The entry whose tarball contains `path`'s bundled children: the path itself unless it is bundled, otherwise the nearest
// ancestor (`<ancestor>/node_modules/<name>`) that is not. Undefined if an ancestor has no entry.
function tarballOwner(packages: Record<string, LockPackage>, path: string): string | undefined {
    let current = path;
    while (packages[current]?.inBundle) {
        const boundary = current.lastIndexOf('/node_modules/');
        if (boundary === -1) return undefined;
        current = current.slice(0, boundary);
    }
    return current in packages ? current : undefined;
}

export interface RepairPlan {
    // New lockfile entries keyed by path.
    additions: Map<string, LockPackage>;
    // Bundlers that could not be repaired, with the reason.
    skipped: Map<string, string>;
}

// Works out which entries to add. Throws RepairError (tarball unreadable, integrity mismatch, ...) for anything that
// must stop the whole repair.
export async function planRepair(lock: Lockfile, fetchTarball: FetchTarball, limits: TarLimits = DEFAULT_TAR_LIMITS): Promise<RepairPlan> {
    const packages = lock.packages ?? {};
    const additions = new Map<string, LockPackage>();
    const skipped = new Map<string, string>();

    // A bundler that is itself bundled has no tarball of its own: its children ship inside the tarball of the nearest
    // ancestor that is not bundled. So the work is grouped by that tarball's owner.
    const missingByOwner = new Map<string, string[]>();
    for (const [bundlerPath, missing] of findBundlersWithMissingEntries(lock)) {
        const owner = tarballOwner(packages, bundlerPath);
        if (owner === undefined) {
            skipped.set(bundlerPath, 'it is bundled by a package that has no entry of its own, so there is no tarball to read');
            continue;
        }
        missingByOwner.set(owner, [...(missingByOwner.get(owner) ?? []), ...missing]);
    }

    for (const [ownerPath, missing] of missingByOwner) {
        const owner = packages[ownerPath]!;
        if (!isRegistryTarballUrl(owner.resolved)) {
            skipped.set(ownerPath, `its "resolved" is not an https://registry.npmjs.org/ URL (${String(owner.resolved)}); it is never fetched`);
            continue;
        }
        if (!hasVerifiableIntegrity(owner.integrity)) {
            skipped.set(ownerPath, 'it has no sha512 "integrity" to verify the tarball against');
            continue;
        }

        const tarball = await fetchTarball(owner.resolved, limits.maxUncompressedBytes);
        verifyIntegrity(tarball, owner.integrity, ownerPath);
        let manifests: Map<string, unknown>;
        try {
            manifests = readBundledManifests(tarball, limits);
        } catch (error) {
            if (error instanceof TarballError) throw new RepairError(`${ownerPath}: ${error.message}`, { cause: error });
            throw error;
        }

        for (const [location, manifest] of manifests) {
            const path = `${ownerPath}/${location}`;
            if (path in packages || !isPlainObject(manifest)) continue;
            additions.set(path, lockEntryFromManifest(manifest, owner));
        }
        const unresolved = missing.filter((path) => !additions.has(path));
        if (unresolved.length > 0) {
            skipped.set(ownerPath, `its tarball does not contain ${unresolved.map((path) => path.slice(ownerPath.length + 1)).join(', ')}`);
        }
    }
    return { additions, skipped };
}

// Inserts the new keys into `packages` at the position npm's sort puts them, leaving every existing entry and its
// order alone.
export function addEntries(packages: Record<string, LockPackage>, additions: Map<string, LockPackage>): Record<string, LockPackage> {
    const entries = Object.entries(packages);
    for (const addition of [...additions].sort(([a], [b]) => compareKeys(a, b))) {
        const index = entries.findIndex(([key]) => compareKeys(key, addition[0]) > 0);
        entries.splice(index === -1 ? entries.length : index, 0, addition);
    }
    return Object.fromEntries(entries);
}

// The file's own formatting, so the rewrite changes nothing but the added entries.
interface Layout {
    indent: string;
    eol: string;
    trailingNewline: boolean;
}

function detectLayout(text: string): Layout {
    return {
        indent: /^([ \t]+)"/m.exec(text)?.[1] ?? '  ',
        eol: text.includes('\r\n') ? '\r\n' : '\n',
        trailingNewline: /\n$/.test(text),
    };
}

function serialize(lock: Lockfile, layout: Layout): string {
    const json = JSON.stringify(lock, null, layout.indent).replace(/\n/g, layout.eol);
    return layout.trailingNewline ? `${json}${layout.eol}` : json;
}

export interface RepairOptions {
    fetchTarball?: FetchTarball;
    limits?: TarLimits;
}

// Reads the lockfile at `argv[0]` (default package-lock.json), adds the missing bundled entries and writes it back.
// Exit 0: repaired, or nothing to repair. Exit 1: the lockfile could not be fully repaired (and is left untouched).
export async function repairLockfile(argv: readonly string[], options: RepairOptions = {}): Promise<CheckLockfileResult> {
    const lockPath = argv[0] ?? 'package-lock.json';
    const text = readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(text) as Lockfile;

    if (findBundlersWithMissingEntries(lock).size === 0) {
        return { code: 0, stdout: `${lockPath}: nothing to repair; all bundled dependency entries are present.\n`, stderr: '' };
    }

    // Re-serializing must reproduce the file exactly, otherwise writing it back would change more than the added
    // entries. npm-written lockfiles always satisfy this.
    const layout = detectLayout(text);
    if (serialize(lock, layout) !== text) {
        return {
            code: 1,
            stdout: '',
            stderr: `${lockPath} is not formatted the way npm writes it, so it cannot be rewritten without unrelated changes. Restore it from the base branch and redo the change.\n`,
        };
    }

    let plan: RepairPlan;
    try {
        plan = await planRepair(lock, options.fetchTarball ?? fetchRegistryTarball, options.limits);
    } catch (error) {
        if (error instanceof RepairError) return { code: 1, stdout: '', stderr: `${lockPath}: cannot repair: ${error.message}\n` };
        throw error;
    }

    if (plan.skipped.size > 0) {
        const lines = [`${lockPath}: cannot repair everything, so nothing was written:`];
        for (const [path, reason] of plan.skipped) lines.push(`  - ${path}: ${reason}`);
        return { code: 1, stdout: '', stderr: `${lines.join('\n')}\n` };
    }

    lock.packages = addEntries(lock.packages ?? {}, plan.additions);
    writeFileSync(lockPath, serialize(lock, layout));
    const lines = [`${lockPath}: added ${plan.additions.size} bundled dependency entr${plan.additions.size === 1 ? 'y' : 'ies'}:`];
    for (const path of plan.additions.keys()) lines.push(`  + ${path}`);
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

// The only network access in this tool. Redirects are refused (the registry serves tarballs directly), so the
// allowlist check on the URL cannot be sidestepped by a redirect to another host.
export async function fetchRegistryTarball(url: string, maxBytes: number): Promise<Buffer> {
    let response: Response;
    try {
        response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch (error) {
        throw new RepairError(`${url}: the download failed (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
    }
    if (!response.ok) throw new RepairError(`${url}: the registry answered ${response.status}.`);
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) throw new RepairError(`${url}: the tarball is larger than ${maxBytes} bytes.`);
    // Also guarded: a body that dies mid-stream rejects here rather than at fetch().
    const body = await response.arrayBuffer().then(Buffer.from, (error: unknown) => {
        throw new RepairError(`${url}: reading the download failed.`, { cause: error });
    });
    if (body.length > maxBytes) throw new RepairError(`${url}: the tarball is larger than ${maxBytes} bytes.`);
    return body;
}

// Only runs when this module is the Node entry point; see check-lockfile.ts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { code, stdout, stderr } = await repairLockfile(process.argv.slice(2));
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = code;
}
