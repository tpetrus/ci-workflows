import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { nextVersion, releaseKind } from './nextVersion.ts';
import type { CommitType } from './parseTitle.ts';

const title = (type: CommitType, breaking = false) => ({ type, breaking });

describe('releaseKind', () => {
    it.each([
        ['feat', 'minor'],
        ['fix', 'patch'],
        ['perf', 'patch'],
        ['refactor', 'patch'],
        ['build', 'patch'],
        ['chore', 'patch'],
        ['revert', 'patch'],
        ['style', 'patch'],
        ['docs', 'none'],
        ['ci', 'none'],
        ['test', 'none'],
    ] as const)('%s is %s', (type, kind) => {
        expect(releaseKind(title(type))).toBe(kind);
    });

    it('treats any breaking title as major, even a docs one', () => {
        expect(releaseKind(title('docs', true))).toBe('major');
    });
});

describe('nextVersion', () => {
    it('bumps by the kind of change', () => {
        expect(nextVersion('1.2.3', title('feat'))).toBe('1.3.0');
        expect(nextVersion('1.2.3', title('fix'))).toBe('1.2.4');
        expect(nextVersion('1.2.3', title('fix', true))).toBe('2.0.0');
    });

    it('leaves the version alone for docs, ci and test', () => {
        expect(nextVersion('1.2.3', title('ci'))).toBe('1.2.3');
    });

    it('graduates a prerelease on a patch, as semver does', () => {
        // Guards the assumption the docs rely on: the prerelease tag is dropped, not incremented.
        expect(semver.inc('0.1.0-beta', 'patch')).toBe('0.1.0');
        expect(nextVersion('0.1.0-beta', title('fix'))).toBe('0.1.0');
        expect(nextVersion('0.1.0-beta', title('feat'))).toBe('0.1.0');
    });

    it('leaves 0.x with a breaking change', () => {
        expect(nextVersion('0.1.0-beta', title('feat', true))).toBe('1.0.0');
        expect(nextVersion('0.4.2', title('fix', true))).toBe('1.0.0');
    });

    it('rejects an invalid base version', () => {
        expect(() => nextVersion('banana', title('fix'))).toThrow(/not a valid semver/);
    });
});
