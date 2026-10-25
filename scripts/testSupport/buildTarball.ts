// Builds small .tgz buffers for specs, so no test needs the network or a committed binary. Test-only: excluded from the
// published build (tsconfig.build.json).
import { gzipSync } from 'node:zlib';

export interface TarEntry {
    name: string;
    // Contents of a regular file. Ignored for non-file types.
    content?: string | Buffer;
    // '0' regular file (default), '2' symlink, '5' directory, 'x' pax header, 'L' GNU long name.
    type?: string;
}

const BLOCK = 512;

function header(name: string, size: number, type: string, prefix = ''): Buffer {
    const block = Buffer.alloc(BLOCK);
    block.write(name, 0, 100, 'utf8');
    block.write('0000644\0', 100);
    block.write('0000000\0', 108);
    block.write('0000000\0', 116);
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    block.write('00000000000\0', 136);
    block.write(type, 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    block.write(prefix, 345, 155, 'utf8');
    return refreshChecksum(block);
}

// Recomputes the header checksum (the sum of all bytes with the checksum field read as spaces), for specs that edit
// a header and want only that edit to be wrong.
export function refreshChecksum(block: Buffer): Buffer {
    block.write('        ', 148);
    const sum = block.subarray(0, BLOCK).reduce((total, byte) => total + byte, 0);
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return block;
}

const padded = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);

// A pax extended header record: `<length> <key>=<value>\n`, where the length counts its own digits.
export function paxRecord(key: string, value: string): string {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
    return `${length}${body}`;
}

export function buildTar(entries: readonly TarEntry[], options: { terminate?: boolean } = {}): Buffer {
    const blocks: Buffer[] = [];
    for (const { name, content = '', type = '0' } of entries) {
        const data = type === '5' || type === '2' ? Buffer.alloc(0) : Buffer.from(content);
        // Names over 100 bytes go in the ustar prefix field (up to 155 bytes), split at a slash, like a real packer does.
        const split = name.length > 100 ? name.lastIndexOf('/', 155) : -1;
        const [prefix, base] = split === -1 ? ['', name] : [name.slice(0, split), name.slice(split + 1)];
        blocks.push(header(base, data.length, type, prefix), padded(data));
    }
    if (options.terminate !== false) blocks.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(blocks);
}

export function buildTarball(entries: readonly TarEntry[], options: { terminate?: boolean } = {}): Buffer {
    return gzipSync(buildTar(entries, options));
}
