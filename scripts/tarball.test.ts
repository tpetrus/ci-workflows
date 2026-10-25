import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TAR_LIMITS, TarballError, readBundledManifests } from './tarball.ts';
import { buildTar, buildTarball, paxRecord, refreshChecksum } from './testSupport/buildTarball.ts';

const json = (value: unknown): string => JSON.stringify(value);

describe('readBundledManifests', () => {
    it('reads scoped, unscoped and nested bundled package.json files, keyed by location', () => {
        const manifests = readBundledManifests(
            buildTarball([
                { name: 'package/package.json', content: json({ name: 'outer' }) },
                { name: 'package/node_modules/a/package.json', content: json({ name: 'a' }) },
                { name: 'package/node_modules/@s/b/package.json', content: json({ name: '@s/b' }) },
                { name: 'package/node_modules/a/node_modules/c/package.json', content: json({ name: 'c' }) },
            ]),
        );
        expect([...manifests.keys()].sort()).toEqual(['node_modules/@s/b', 'node_modules/a', 'node_modules/a/node_modules/c']);
        expect(manifests.get('node_modules/a')).toEqual({ name: 'a' });
    });

    it('ignores a package.json that is not at a node_modules/<name> root', () => {
        // tslib ships node_modules/tslib/modules/package.json as a module-type marker; it is not a package.
        const manifests = readBundledManifests(
            buildTarball([
                { name: 'package/node_modules/tslib/modules/package.json', content: json({ type: 'module' }) },
                { name: 'package/node_modules/tslib/package.json', content: json({ name: 'tslib' }) },
                { name: 'package/other/package.json', content: json({ name: 'other' }) },
            ]),
        );
        expect([...manifests.keys()]).toEqual(['node_modules/tslib']);
    });

    it('skips symlinks, hardlinks and directories, even when they are named like a manifest', () => {
        const manifests = readBundledManifests(
            buildTarball([
                { name: 'package/node_modules/a/package.json', type: '2', content: 'ignored' },
                { name: 'package/node_modules/b/package.json', type: '1' },
                { name: 'package/node_modules/c/package.json', type: '5' },
            ]),
        );
        expect(manifests.size).toBe(0);
    });

    it('uses a pax path header for the next entry only', () => {
        const longName = `package/node_modules/${'x'.repeat(120)}/package.json`;
        const manifests = readBundledManifests(
            buildTarball([
                { name: 'pax', type: 'x', content: paxRecord('path', longName) },
                { name: 'short', content: json({ name: 'long' }) },
                { name: 'package/node_modules/b/package.json', content: json({ name: 'b' }) },
            ]),
        );
        expect([...manifests.keys()]).toEqual([`node_modules/${'x'.repeat(120)}`, 'node_modules/b']);
    });

    it('uses a GNU long name header and skips global pax headers', () => {
        const manifests = readBundledManifests(
            buildTarball([
                { name: 'global', type: 'g', content: paxRecord('comment', 'hello') },
                { name: 'long', type: 'L', content: 'package/node_modules/a/package.json\0' },
                { name: 'short', content: json({ name: 'a' }) },
            ]),
        );
        expect([...manifests.keys()]).toEqual(['node_modules/a']);
    });

    it('uses the ustar prefix field for names over 100 bytes', () => {
        const name = `package/node_modules/${'y'.repeat(90)}/package.json`;
        const manifests = readBundledManifests(buildTarball([{ name, content: json({ name: 'y' }) }]));
        expect([...manifests.keys()]).toEqual([`node_modules/${'y'.repeat(90)}`]);
    });

    it('rejects data that is not gzip', () => {
        expect(() => readBundledManifests(Buffer.from('not gzip'))).toThrow(/not valid gzip/);
    });

    it('rejects a tarball that decompresses past the cap', () => {
        const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024));
        expect(() => readBundledManifests(bomb, { ...DEFAULT_TAR_LIMITS, maxUncompressedBytes: 1024 * 1024 })).toThrow(/exceeds 1048576 bytes/);
    });

    it('rejects a tarball with too many entries', () => {
        const entries = Array.from({ length: 5 }, (_, i) => ({ name: `package/file${i}` }));
        expect(() => readBundledManifests(buildTarball(entries), { ...DEFAULT_TAR_LIMITS, maxEntries: 4 })).toThrow(/more than 4 entries/);
    });

    it('rejects an oversized manifest', () => {
        const tgz = buildTarball([{ name: 'package/node_modules/a/package.json', content: json({ pad: 'z'.repeat(200) }) }]);
        expect(() => readBundledManifests(tgz, { ...DEFAULT_TAR_LIMITS, maxManifestBytes: 100 })).toThrow(/larger than 100 bytes/);
    });

    it('rejects a manifest that is not JSON', () => {
        const tgz = buildTarball([{ name: 'package/node_modules/a/package.json', content: '{nope' }]);
        expect(() => readBundledManifests(tgz)).toThrow(/not valid JSON/);
    });

    it('rejects a corrupted header', () => {
        const tar = buildTar([{ name: 'package/node_modules/a/package.json', content: '{}' }]);
        tar[0] = (tar[0] ?? 0) ^ 0xff;
        expect(() => readBundledManifests(gzipSync(tar))).toThrow(/checksum/);
    });

    it('rejects a malformed size field', () => {
        const tar = buildTar([{ name: 'package/node_modules/a/package.json', content: '{}' }]);
        tar.write('zzzzzzzzzzz\0', 124);
        refreshChecksum(tar.subarray(0, 512));
        expect(() => readBundledManifests(gzipSync(tar))).toThrow(/Malformed size/);
    });

    it('rejects a base-256 size field', () => {
        const tar = buildTar([{ name: 'package/node_modules/a/package.json', content: '{}' }]);
        tar[124] = 0x80;
        refreshChecksum(tar.subarray(0, 512));
        expect(() => readBundledManifests(gzipSync(tar))).toThrow(TarballError);
    });

    it('rejects a truncated entry', () => {
        const tar = buildTar([{ name: 'package/node_modules/a/package.json', content: 'x'.repeat(2000) }]);
        expect(() => readBundledManifests(gzipSync(tar.subarray(0, 700)))).toThrow(/truncated/);
    });

    it('rejects a tarball without an end-of-archive marker', () => {
        const tgz = buildTarball([{ name: 'package/node_modules/a/package.json', content: '{}' }], { terminate: false });
        expect(() => readBundledManifests(tgz)).toThrow(/no end-of-archive marker/);
    });

    it('rejects a malformed pax record', () => {
        const tgz = buildTarball([{ name: 'pax', type: 'x', content: 'garbage' }]);
        expect(() => readBundledManifests(tgz)).toThrow(/Malformed pax/);
    });

    it('rejects a pax record without an equals sign', () => {
        const body = ' nokeyvalue\n';
        const tgz = buildTarball([{ name: 'pax', type: 'x', content: `${body.length + 2}${body}` }]);
        expect(() => readBundledManifests(tgz)).toThrow(/Malformed pax/);
    });

    it('honors a pax size and rejects a malformed one', () => {
        const ok = buildTarball([
            { name: 'pax', type: 'x', content: paxRecord('size', '2') },
            { name: 'package/node_modules/a/package.json', content: '{}' },
        ]);
        expect(readBundledManifests(ok).get('node_modules/a')).toEqual({});
        const bad = buildTarball([{ name: 'pax', type: 'x', content: paxRecord('size', 'big') }]);
        expect(() => readBundledManifests(bad)).toThrow(/Malformed pax size/);
    });
});
