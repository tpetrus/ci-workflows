import semver from 'semver';
import type { CommitType, ParsedTitle } from './parseTitle.ts';

export type ReleaseKind = 'major' | 'minor' | 'patch' | 'none';

const PATCH_TYPES: readonly CommitType[] = ['fix', 'perf', 'refactor', 'build', 'chore', 'revert', 'style'];

// `!` always wins, then feat is a minor and the maintenance types are patches. docs, ci and test never ship, so they
// release nothing.
export function releaseKind(title: Pick<ParsedTitle, 'type' | 'breaking'>): ReleaseKind {
    if (title.breaking) return 'major';
    if (title.type === 'feat') return 'minor';
    if (PATCH_TYPES.includes(title.type)) return 'patch';
    return 'none';
}

// The version the PR must carry, given the version on its base branch.
//
// This is plain semver, so a prerelease base graduates instead of incrementing: `semver.inc('0.1.0-beta', 'patch')` is
// `0.1.0`, and a `feat` on `0.1.0-beta` is also `0.1.0` (the minor is already 1). Below 1.0.0 a breaking change still
// means major, so `0.1.0-beta` plus `!` is `1.0.0`; that is intended, it is how the project leaves 0.x.
export function nextVersion(baseVersion: string, title: Pick<ParsedTitle, 'type' | 'breaking'>): string {
    const base = semver.valid(baseVersion);
    if (base === null) throw new Error(`"${baseVersion}" is not a valid semver version.`);
    const kind = releaseKind(title);
    if (kind === 'none') return base;
    const next = semver.inc(base, kind);
    // inc only returns null for an invalid version, which was ruled out above.
    if (next === null) throw new Error(`Could not bump ${base} by ${kind}.`);
    return next;
}
