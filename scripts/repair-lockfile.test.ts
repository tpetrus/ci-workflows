import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockPackage, Lockfile } from './check-lockfile.ts';
import {
    addEntries,
    fetchRegistryTarball,
    hasVerifiableIntegrity,
    isRegistryTarballUrl,
    lockEntryFromManifest,
    repairLockfile,
    sortLikeNpm,
} from './repair-lockfile.ts';
import type { FetchTarball } from './repair-lockfile.ts';
import { DEFAULT_TAR_LIMITS } from './tarball.ts';
import { buildTarball } from './testSupport/buildTarball.ts';

const BUNDLER = 'node_modules/@tailwindcss/oxide-wasm32-wasi';
const REGISTRY_URL = 'https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz';

const sriOf = (tarball: Buffer): string => `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

// The real package.json files of the six packages @tailwindcss/oxide-wasm32-wasi 4.3.3 bundles, and a slice of a real
// npm-written lockfile (AudioVisualizer-React's) around them. Both were extracted once from the published tarball and
// that lockfile.
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/oxide-wasm32-wasi/${name}`, import.meta.url), 'utf8');
const realManifests = JSON.parse(fixture('manifests.json')) as Record<string, unknown>;

// A tarball shaped like the real one: the bundled packages' manifests plus the noise around them (other files, and
// tslib's node_modules/tslib/modules/package.json marker, which is not a package).
const realTarball = buildTarball([
    { name: 'package/package.json', content: JSON.stringify({ name: '@tailwindcss/oxide-wasm32-wasi' }) },
    { name: 'package/tailwindcss-oxide.wasi.cjs', content: '// glue' },
    { name: 'package/node_modules/tslib/modules/package.json', content: JSON.stringify({ type: 'module' }) },
    ...Object.entries(realManifests).map(([location, manifest]) => ({
        name: `package/${location}/package.json`,
        content: JSON.stringify(manifest, null, 2),
    })),
]);

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repair-lockfile-'));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const lockPath = (): string => join(dir, 'package-lock.json');

// The fixture lockfile, with the bundler's integrity pointed at `tarball`, as text in npm's format.
function completeLockText(tarball: Buffer, format: { indent?: string | number; eol?: string; trailingNewline?: boolean } = {}): string {
    const lock = JSON.parse(fixture('lockfile.json')) as Lockfile;
    lock.packages![BUNDLER]!.integrity = sriOf(tarball);
    const json = JSON.stringify(lock, null, format.indent ?? 2).replace(/\n/g, format.eol ?? '\n');
    return format.trailingNewline === false ? json : `${json}${format.eol ?? '\n'}`;
}

function withoutBundledChildren(text: string): string {
    const lock = JSON.parse(text) as Lockfile;
    for (const key of Object.keys(lock.packages!)) {
        if (key.startsWith(`${BUNDLER}/node_modules/`)) delete lock.packages![key];
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indent = /^([ \t]+)"/m.exec(text)![1];
    const json = JSON.stringify(lock, null, indent).replace(/\n/g, eol);
    return text.endsWith('\n') ? `${json}${eol}` : json;
}

const serving = (tarball: Buffer) => vi.fn<FetchTarball>(async () => tarball);

describe('golden: the real bundled packages', () => {
    it('restores a lockfile with the six entries deleted byte-for-byte', async () => {
        const original = completeLockText(realTarball);
        writeFileSync(lockPath(), withoutBundledChildren(original));
        const fetchTarball = serving(realTarball);

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('added 6 bundled dependency entries');
        expect(readFileSync(lockPath(), 'utf8')).toBe(original);
        expect(fetchTarball).toHaveBeenCalledExactlyOnceWith(REGISTRY_URL, DEFAULT_TAR_LIMITS.maxUncompressedBytes);
    });

    it.each([
        ['tab indentation', { indent: '\t' }],
        ['four-space indentation', { indent: 4 }],
        ['CRLF line endings', { eol: '\r\n' }],
        ['no trailing newline', { trailingNewline: false }],
    ])('preserves %s', async (_, format) => {
        const original = completeLockText(realTarball, format);
        writeFileSync(lockPath(), withoutBundledChildren(original));

        const result = await repairLockfile([lockPath()], { fetchTarball: serving(realTarball) });

        expect(result.code).toBe(0);
        expect(readFileSync(lockPath(), 'utf8')).toBe(original);
    });

    it('does nothing and fetches nothing when the lockfile is already complete', async () => {
        const original = completeLockText(realTarball);
        writeFileSync(lockPath(), original);
        const fetchTarball = serving(realTarball);

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result).toEqual({ code: 0, stdout: expect.stringContaining('nothing to repair'), stderr: '' });
        expect(readFileSync(lockPath(), 'utf8')).toBe(original);
        expect(fetchTarball).not.toHaveBeenCalled();
    });

    it('defaults to package-lock.json in the working directory', async () => {
        const cwd = vi.spyOn(process, 'cwd');
        const previous = process.cwd();
        process.chdir(dir);
        try {
            writeFileSync(lockPath(), completeLockText(realTarball));
            expect((await repairLockfile([])).stdout).toContain('package-lock.json: nothing to repair');
        } finally {
            process.chdir(previous);
            cwd.mockRestore();
        }
    });
});

describe('refusals leave the lockfile untouched', () => {
    const broken = (tarball: Buffer, patch: (lock: Lockfile) => void = () => {}): string => {
        const lock = JSON.parse(withoutBundledChildren(completeLockText(tarball))) as Lockfile;
        patch(lock);
        return `${JSON.stringify(lock, null, 2)}\n`;
    };

    it('fails on an integrity mismatch, before parsing the tarball', async () => {
        const text = broken(realTarball);
        writeFileSync(lockPath(), text);

        const result = await repairLockfile([lockPath()], { fetchTarball: serving(buildTarball([{ name: 'package/x', content: 'tampered' }])) });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("does not match the lockfile's integrity");
        expect(readFileSync(lockPath(), 'utf8')).toBe(text);
    });

    it('fails on an integrity mismatch even when the tarball is not a tarball at all', async () => {
        writeFileSync(lockPath(), broken(realTarball));

        const result = await repairLockfile([lockPath()], { fetchTarball: serving(Buffer.from('garbage')) });

        expect(result.stderr).toContain('integrity');
    });

    it.each([
        ['a non-registry host', 'https://evil.example/pkg.tgz'],
        ['plain http', 'http://registry.npmjs.org/pkg.tgz'],
        ['a lookalike host', 'https://registry.npmjs.org.evil.example/pkg.tgz'],
        ['credentials in the URL', 'https://user:pw@registry.npmjs.org/pkg.tgz'],
        ['a custom port', 'https://registry.npmjs.org:8443/pkg.tgz'],
        ['a git URL', 'git+ssh://git@github.com/o/r.git'],
        ['a file path', 'file:../pkg.tgz'],
    ])('never fetches %s', async (_, resolved) => {
        const text = broken(realTarball, (lock) => {
            lock.packages![BUNDLER]!.resolved = resolved;
        });
        writeFileSync(lockPath(), text);
        const fetchTarball = serving(realTarball);

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('is not an https://registry.npmjs.org/ URL');
        expect(result.stderr).toContain('nothing was written');
        expect(fetchTarball).not.toHaveBeenCalled();
        expect(readFileSync(lockPath(), 'utf8')).toBe(text);
    });

    it('never fetches a bundler without a resolved URL', async () => {
        writeFileSync(
            lockPath(),
            broken(realTarball, (lock) => {
                delete lock.packages![BUNDLER]!.resolved;
            }),
        );
        const fetchTarball = serving(realTarball);

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result.code).toBe(1);
        expect(fetchTarball).not.toHaveBeenCalled();
    });

    it('skips a bundler with no sha512 integrity', async () => {
        writeFileSync(
            lockPath(),
            broken(realTarball, (lock) => {
                lock.packages![BUNDLER]!.integrity = 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
            }),
        );
        const fetchTarball = serving(realTarball);

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('no sha512 "integrity"');
        expect(fetchTarball).not.toHaveBeenCalled();
    });

    it('fails on a tarball that is not valid, once its integrity matches', async () => {
        const malformed = buildTarball([{ name: 'package/node_modules/a/package.json', content: '{}' }], { terminate: false });
        writeFileSync(
            lockPath(),
            broken(realTarball, (lock) => {
                lock.packages![BUNDLER]!.integrity = sriOf(malformed);
            }),
        );

        const result = await repairLockfile([lockPath()], { fetchTarball: serving(malformed) });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('no end-of-archive marker');
    });

    it('fails when the tarball is over the size cap', async () => {
        writeFileSync(lockPath(), broken(realTarball));

        const result = await repairLockfile([lockPath()], {
            fetchTarball: serving(realTarball),
            limits: { ...DEFAULT_TAR_LIMITS, maxUncompressedBytes: 1024 },
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('exceeds 1024 bytes');
    });

    it('fails when the tarball does not contain a declared bundled package', async () => {
        const partial = buildTarball([{ name: 'package/node_modules/tslib/package.json', content: JSON.stringify({ name: 'tslib', version: '2.8.1' }) }]);
        const text = broken(realTarball, (lock) => {
            lock.packages![BUNDLER]!.integrity = sriOf(partial);
        });
        writeFileSync(lockPath(), text);

        const result = await repairLockfile([lockPath()], { fetchTarball: serving(partial) });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("its tarball does not contain");
        expect(result.stderr).toContain("node_modules/@emnapi/core");
        expect(readFileSync(lockPath(), 'utf8')).toBe(text);
    });

    it('reports a failed download as an error, not a crash', async () => {
        writeFileSync(lockPath(), broken(realTarball));
        const fetchTarball = vi.fn<FetchTarball>(async () => {
            const { RepairError } = await import('./repair-lockfile.ts');
            throw new RepairError('the registry answered 503.');
        });

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result).toEqual({ code: 1, stdout: '', stderr: expect.stringContaining('the registry answered 503') });
    });

    it('rethrows an unexpected error', async () => {
        writeFileSync(lockPath(), broken(realTarball));

        await expect(
            repairLockfile([lockPath()], {
                fetchTarball: async () => {
                    throw new TypeError('bug');
                },
            }),
        ).rejects.toThrow('bug');
    });

    it('refuses to rewrite a lockfile that is not formatted the way npm writes it', async () => {
        const text = JSON.stringify(JSON.parse(broken(realTarball)));
        writeFileSync(lockPath(), text);
        const fetchTarball = serving(realTarball);

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('not formatted the way npm writes it');
        expect(fetchTarball).not.toHaveBeenCalled();
        expect(readFileSync(lockPath(), 'utf8')).toBe(text);
    });
});

describe('nested bundled dependencies', () => {
    const outerTarball = buildTarball([
        { name: 'package/node_modules/a/package.json', content: JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { b: '^2.0.0' } }) },
        { name: 'package/node_modules/a/node_modules/b/package.json', content: JSON.stringify({ name: 'b', version: '2.0.0' }) },
    ]);
    const lockOf = (packages: Record<string, LockPackage>): string => `${JSON.stringify({ name: 'p', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
    const outer = { version: '1.0.0', resolved: REGISTRY_URL, integrity: sriOf(outerTarball), bundleDependencies: ['a'], dev: true };

    it('adds entries at every depth, in npm order, with inherited flags', async () => {
        writeFileSync(lockPath(), lockOf({ '': {}, 'node_modules/outer': outer, 'node_modules/zed': { version: '1.0.0' } }));

        const result = await repairLockfile([lockPath()], { fetchTarball: serving(outerTarball) });

        expect(result.code).toBe(0);
        const lock = JSON.parse(readFileSync(lockPath(), 'utf8')) as Lockfile;
        expect(Object.keys(lock.packages!)).toEqual([
            '',
            'node_modules/outer',
            'node_modules/outer/node_modules/a',
            'node_modules/outer/node_modules/a/node_modules/b',
            'node_modules/zed',
        ]);
        expect(lock.packages!['node_modules/outer/node_modules/a/node_modules/b']).toEqual({ version: '2.0.0', dev: true, inBundle: true });
    });

    it("repairs a bundled bundler's missing children through the outer tarball", async () => {
        // `a` is present and itself bundles `b`, but `b` is missing: only the outer package has a tarball to read.
        writeFileSync(
            lockPath(),
            lockOf({
                '': {},
                'node_modules/outer': outer,
                'node_modules/outer/node_modules/a': { version: '1.0.0', inBundle: true, dev: true, bundleDependencies: ['b'] },
            }),
        );
        const fetchTarball = serving(outerTarball);

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('added 1 bundled dependency entry');
        expect(Object.keys((JSON.parse(readFileSync(lockPath(), 'utf8')) as Lockfile).packages!)).toContain('node_modules/outer/node_modules/a/node_modules/b');
        expect(fetchTarball).toHaveBeenCalledTimes(1);
    });

    it("fails when a bundled bundler's children are not in its outer tarball", async () => {
        const text = lockOf({
            '': {},
            'node_modules/outer': outer,
            'node_modules/outer/node_modules/a': { version: '1.0.0', inBundle: true, bundleDependencies: ['missing'] },
        });
        writeFileSync(lockPath(), text);

        const result = await repairLockfile([lockPath()], { fetchTarball: serving(outerTarball) });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('node_modules/outer: its tarball does not contain node_modules/a/node_modules/missing');
        expect(readFileSync(lockPath(), 'utf8')).toBe(text);
    });

    it('fails when the package that bundles a bundler has no entry', async () => {
        const text = lockOf({ '': {}, 'node_modules/outer/node_modules/a': { version: '1.0.0', inBundle: true, bundleDependencies: ['b'] } });
        writeFileSync(lockPath(), text);
        const fetchTarball = serving(outerTarball);

        const result = await repairLockfile([lockPath()], { fetchTarball });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('no tarball to read');
        expect(fetchTarball).not.toHaveBeenCalled();
    });

    it('fails when a bundled bundler has no enclosing package at all', async () => {
        writeFileSync(lockPath(), lockOf({ '': {}, 'a': { version: '1.0.0', inBundle: true, bundleDependencies: ['b'] } }));

        expect((await repairLockfile([lockPath()], { fetchTarball: serving(outerTarball) })).code).toBe(1);
    });
});

describe('lockEntryFromManifest', () => {
    const bundler: LockPackage = { dev: true, optional: true, peer: true, devOptional: true };

    it('writes the fields npm writes, in npm order, and inherits the flags', () => {
        const entry = lockEntryFromManifest(
            {
                name: 'pkg',
                version: '1.2.3',
                description: 'dropped',
                license: { type: 'MIT', url: 'https://example.com' },
                bin: 'cli.js',
                dependencies: { z: '1', a: '2' },
                peerDependencies: { p: '*' },
                peerDependenciesMeta: { p: { optional: true } },
                optionalDependencies: { o: '1' },
                funding: { url: 'https://f.example', type: 'github' },
                engines: { node: '>=1' },
                os: ['linux'],
                cpu: ['x64'],
                libc: ['glibc'],
                deprecated: 'old',
                workspaces: ['w'],
                acceptDependencies: { q: '1' },
                scripts: { postinstall: 'x' },
                _integrity: 'sha512-abc',
                _resolved: 'https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz',
            },
            bundler,
        );
        expect(JSON.stringify(entry)).toBe(
            JSON.stringify({
                version: '1.2.3',
                resolved: 'https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz',
                integrity: 'sha512-abc',
                cpu: ['x64'],
                deprecated: 'old',
                dev: true,
                devOptional: true,
                hasInstallScript: true,
                inBundle: true,
                libc: ['glibc'],
                license: 'MIT',
                optional: true,
                os: ['linux'],
                peer: true,
                workspaces: ['w'],
                dependencies: { a: '2', z: '1' },
                acceptDependencies: { q: '1' },
                bin: { pkg: 'cli.js' },
                engines: { node: '>=1' },
                funding: { type: 'github', url: 'https://f.example' },
                optionalDependencies: { o: '1' },
                peerDependencies: { p: '*' },
                peerDependenciesMeta: { p: { optional: true } },
            }),
        );
    });

    it('drops empty and falsy values, and flags the bundler does not have', () => {
        const entry = lockEntryFromManifest({ name: 'pkg', version: '1.0.0', dependencies: {}, os: [], license: '', hasInstallScript: false, scripts: { test: 'x' } }, {});
        expect(entry).toEqual({ version: '1.0.0', inBundle: true });
    });

    it('keeps a string license and an unscoped bin name for a scoped package', () => {
        const entry = lockEntryFromManifest({ name: '@s/pkg', version: '1.0.0', license: 'ISC', bin: 'b.js', hasInstallScript: true }, {});
        expect(entry).toMatchObject({ license: 'ISC', bin: { pkg: 'b.js' }, hasInstallScript: true });
    });

    it('normalizes bundledDependencies: a list is kept, true means every dependency', () => {
        expect(lockEntryFromManifest({ name: 'p', version: '1', bundledDependencies: ['x'] }, {}).bundleDependencies).toEqual(['x']);
        expect(lockEntryFromManifest({ name: 'p', version: '1', dependencies: { x: '1' }, bundleDependencies: true }, {}).bundleDependencies).toEqual(['x']);
        expect(lockEntryFromManifest({ name: 'p', version: '1', bundleDependencies: true }, {}).bundleDependencies).toBeUndefined();
    });

    it('tolerates a manifest with no name', () => {
        expect(lockEntryFromManifest({ version: '1', bin: 'x.js' }, {})).toMatchObject({ bin: { '': 'x.js' } });
    });
});

describe('sortLikeNpm', () => {
    it('puts scalars and arrays before objects, preferred keys first, the rest by locale order', () => {
        const sorted = sortLikeNpm({ z: { x: 1 }, b: [2], dependencies: { q: 1 }, version: '1', a: 'x', resolved: 'r', B: 'upper' });
        expect(Object.keys(sorted as object)).toEqual(['version', 'resolved', 'a', 'b', 'B', 'dependencies', 'z']);
    });

    it('sorts nested objects, including inside arrays, and leaves scalars alone', () => {
        expect(JSON.stringify(sortLikeNpm({ list: [{ b: 1, a: 2 }], n: null, s: 'x' }))).toBe('{"list":[{"a":2,"b":1}],"n":null,"s":"x"}');
    });
});

describe('addEntries', () => {
    it('inserts at the sorted position and appends past the end, leaving existing entries alone', () => {
        const result = addEntries(
            { '': {}, 'node_modules/a': { version: '1' }, 'node_modules/c': { version: '3' } },
            new Map([
                ['node_modules/d', { version: '4' }],
                ['node_modules/b', { version: '2' }],
            ]),
        );
        expect(Object.keys(result)).toEqual(['', 'node_modules/a', 'node_modules/b', 'node_modules/c', 'node_modules/d']);
    });
});

describe('isRegistryTarballUrl / hasVerifiableIntegrity', () => {
    it('accepts only https registry.npmjs.org URLs', () => {
        expect(isRegistryTarballUrl(REGISTRY_URL)).toBe(true);
        expect(isRegistryTarballUrl('not a url')).toBe(false);
        expect(isRegistryTarballUrl(undefined)).toBe(false);
    });

    it('accepts an SRI string only if it carries a sha512', () => {
        expect(hasVerifiableIntegrity(sriOf(Buffer.from('x')))).toBe(true);
        expect(hasVerifiableIntegrity(`sha1-AAAA ${sriOf(Buffer.from('x'))}`)).toBe(true);
        expect(hasVerifiableIntegrity('sha1-AAAA')).toBe(false);
        expect(hasVerifiableIntegrity(undefined)).toBe(false);
    });
});

describe('fetchRegistryTarball', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the body and refuses redirects', async () => {
        const fetchMock = vi.fn(async () => new Response(Buffer.from('tarball'), { headers: { 'content-length': '7' } }));
        vi.stubGlobal('fetch', fetchMock);

        expect((await fetchRegistryTarball(REGISTRY_URL, 100)).toString()).toBe('tarball');
        expect(fetchMock).toHaveBeenCalledWith(REGISTRY_URL, expect.objectContaining({ redirect: 'error' }));
    });

    it('rejects an error status', async () => {
        vi.stubGlobal('fetch', async () => new Response('no', { status: 404 }));
        await expect(fetchRegistryTarball(REGISTRY_URL, 100)).rejects.toThrow('answered 404');
    });

    it('rejects a declared size over the cap without reading the body', async () => {
        vi.stubGlobal('fetch', async () => new Response('x', { headers: { 'content-length': '1000' } }));
        await expect(fetchRegistryTarball(REGISTRY_URL, 100)).rejects.toThrow('larger than 100 bytes');
    });

    it('rejects a body over the cap when no size was declared', async () => {
        vi.stubGlobal('fetch', async () => new Response('x'.repeat(200)));
        await expect(fetchRegistryTarball(REGISTRY_URL, 100)).rejects.toThrow('larger than 100 bytes');
    });

    it('turns a network error into a RepairError', async () => {
        vi.stubGlobal('fetch', async () => {
            throw new TypeError('fetch failed');
        });
        await expect(fetchRegistryTarball(REGISTRY_URL, 100)).rejects.toThrow('the download failed (fetch failed)');
    });

    it('turns a failed body read into a RepairError', async () => {
        const response = new Response('x');
        vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('reset'));
        vi.stubGlobal('fetch', async () => response);
        await expect(fetchRegistryTarball(REGISTRY_URL, 100)).rejects.toThrow('reading the download failed');
    });
});
