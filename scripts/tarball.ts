// A minimal, in-memory reader for npm package tarballs (.tgz), built for one job: pulling the package.json of every
// bundled dependency out of a package's tarball so repair-lockfile can rebuild lockfile entries. It is deliberately
// not a general tar library:
//  - Nothing is ever written to disk, so there is no path-traversal or symlink surface to defend. Entry names are only
//    compared against one pattern and never used as file paths.
//  - Only regular files are read. Symlinks, hardlinks, directories and devices are skipped.
//  - The input is untrusted, so decompressed size, entry count and the size of each manifest are capped. A cap
//    violation is an error, never a silent truncation.
// npm itself reads these tarballs with the `tar` package; this is the small subset of ustar, GNU long names and pax
// headers that npm's own packer produces.
import { gunzipSync } from 'node:zlib';

export interface TarLimits {
    // Maximum size of the decompressed tar stream (guards against a gzip bomb).
    maxUncompressedBytes: number;
    // Maximum number of tar headers (entries plus pax/GNU extension headers).
    maxEntries: number;
    // Maximum size of one bundled package.json.
    maxManifestBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
    maxUncompressedBytes: 50 * 1024 * 1024,
    maxEntries: 20_000,
    maxManifestBytes: 1024 * 1024,
};

export class TarballError extends Error {}

const BLOCK = 512;

// `node_modules/<name>/package.json` or `node_modules/@scope/<name>/package.json`, repeated for nested bundles
// (`node_modules/a/node_modules/b/package.json`). A package.json deeper inside a package (such as tslib's
// `node_modules/tslib/modules/package.json` module-type marker) is not a package of its own and must not match.
const BUNDLED_MANIFEST = /^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+)package\.json$/;

function readString(header: Buffer, start: number, length: number): string {
    const field = header.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function readOctal(header: Buffer, start: number, length: number, what: string): number {
    // A set high bit means GNU base-256 encoding, which only appears for files over 8 GiB; far beyond any cap here.
    if (((header[start] ?? 0) & 0x80) !== 0) throw new TarballError(`Unsupported ${what} encoding in tar header.`);
    const text = readString(header, start, length).trim();
    if (!/^[0-7]+$/.test(text)) throw new TarballError(`Malformed ${what} in tar header.`);
    return Number.parseInt(text, 8);
}

function verifyChecksum(header: Buffer): void {
    const stored = readOctal(header, 148, 8, 'checksum');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    if (sum !== stored) throw new TarballError('Tar header checksum mismatch.');
}

// Pax extended header records look like `<length> <key>=<value>\n`, where <length> counts the whole record.
function parsePaxRecords(data: Buffer): Map<string, string> {
    const records = new Map<string, string>();
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        const length = space === -1 ? Number.NaN : Number.parseInt(data.subarray(offset, space).toString('utf8'), 10);
        if (!Number.isInteger(length) || length <= space - offset + 1 || offset + length > data.length) {
            throw new TarballError('Malformed pax header record.');
        }
        const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
        const equals = record.indexOf('=');
        if (equals === -1) throw new TarballError('Malformed pax header record.');
        records.set(record.slice(0, equals), record.slice(equals + 1));
        offset += length;
    }
    return records;
}

// Returns the parsed package.json of every bundled package in the tarball, keyed by its location relative to the
// package root (`node_modules/@emnapi/core`, `node_modules/a/node_modules/b`, ...). Throws TarballError for anything
// malformed or over a limit.
export function readBundledManifests(tgz: Buffer, limits: TarLimits = DEFAULT_TAR_LIMITS): Map<string, unknown> {
    let tar: Buffer;
    try {
        tar = gunzipSync(tgz, { maxOutputLength: limits.maxUncompressedBytes });
    } catch (error) {
        const reason = error instanceof RangeError ? `exceeds ${limits.maxUncompressedBytes} bytes when decompressed` : 'is not valid gzip data';
        throw new TarballError(`The tarball ${reason}.`, { cause: error });
    }

    const manifests = new Map<string, unknown>();
    let offset = 0;
    let headers = 0;
    // Names set by a preceding pax ('x') or GNU long-name ('L') header apply to the next entry only.
    let pendingPath: string | undefined;
    let pendingSize: number | undefined;
    let sawEnd = false;

    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        offset += BLOCK;
        // The archive ends at an all-zero block.
        if (header.every((byte) => byte === 0)) {
            sawEnd = true;
            break;
        }
        headers += 1;
        if (headers > limits.maxEntries) throw new TarballError(`The tarball has more than ${limits.maxEntries} entries.`);
        verifyChecksum(header);

        const type = String.fromCharCode(header[156] ?? 0);
        const size = pendingSize ?? readOctal(header, 124, 12, 'size');
        const dataStart = offset;
        const dataEnd = dataStart + size;
        if (dataEnd > tar.length) throw new TarballError('The tarball is truncated.');
        // Entry data is padded to a whole number of blocks.
        offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

        if (type === 'x') {
            const records = parsePaxRecords(tar.subarray(dataStart, dataEnd));
            pendingPath = records.get('path') ?? pendingPath;
            const paxSize = records.get('size');
            if (paxSize !== undefined) {
                if (!/^\d+$/.test(paxSize)) throw new TarballError('Malformed pax size.');
                pendingSize = Number.parseInt(paxSize, 10);
            }
            continue;
        }
        if (type === 'L') {
            pendingPath = readString(tar.subarray(dataStart, dataEnd), 0, size);
            continue;
        }
        if (type === 'g') continue;

        const prefix = readString(header, 345, 155);
        const ustarName = readString(header, 0, 100);
        const name = pendingPath ?? (prefix === '' ? ustarName : `${prefix}/${ustarName}`);
        pendingPath = undefined;
        pendingSize = undefined;

        // '0' and NUL are regular files; everything else is skipped without being read.
        if (type !== '0' && type !== '\0') continue;
        // Drop the top-level directory (`package/` for npm tarballs; npm accepts any name).
        const relative = name.slice(name.indexOf('/') + 1);
        const match = name.includes('/') ? BUNDLED_MANIFEST.exec(relative) : null;
        if (match === null) continue;
        if (size > limits.maxManifestBytes) throw new TarballError(`${name} is larger than ${limits.maxManifestBytes} bytes.`);
        try {
            manifests.set(match[1]!.slice(0, -1), JSON.parse(tar.subarray(dataStart, dataEnd).toString('utf8')) as unknown);
        } catch (error) {
            throw new TarballError(`${name} is not valid JSON.`, { cause: error });
        }
    }

    if (!sawEnd) throw new TarballError('The tarball is truncated (no end-of-archive marker).');
    return manifests;
}
