// Edits the `version` fields of package.json and package-lock.json as text, not by parsing and re-serialising, so the
// diff is exactly the version lines and the files' formatting is untouched. (Running `npm version` would also rewrite
// the lockfile, which on Windows drops entries; see the lockfile check in check-lockfile.ts.)

const VERSION_FIELD = /("version":\s*")([^"]*)(")/;

function replaceFrom(text: string, start: number, version: string): string {
    const tail = text.slice(start);
    if (!VERSION_FIELD.test(tail)) throw new Error('No "version" field found.');
    return text.slice(0, start) + tail.replace(VERSION_FIELD, `$1${version}$3`);
}

function readAt(text: string, path: readonly string[]): unknown {
    let node: unknown = JSON.parse(text);
    for (const key of path) node = (node as Record<string, unknown> | undefined)?.[key];
    return node;
}

export function setPackageVersion(text: string, version: string): string {
    const result = replaceFrom(text, 0, version);
    if (readAt(result, ['version']) !== version) throw new Error(`Edit did not set version to ${version}.`);
    return result;
}

// The lockfile repeats the root version inside `packages[""]`. The top-level `version` comes before `packages`, and the
// root entry is the first key inside it, so the two edits are found by position. The result is parsed afterwards to
// prove both landed where intended.
export function setLockfileVersion(text: string, version: string): string {
    let result = replaceFrom(text, 0, version);
    const packagesAt = result.indexOf('"packages"');
    const rootAt = packagesAt === -1 ? -1 : result.indexOf('"":', packagesAt);
    if (rootAt === -1) throw new Error('No packages[""] entry found.');
    result = replaceFrom(result, rootAt, version);
    if (readAt(result, ['version']) !== version || readAt(result, ['packages', '', 'version']) !== version) {
        throw new Error(`Edit did not set the lockfile versions to ${version}.`);
    }
    return result;
}
