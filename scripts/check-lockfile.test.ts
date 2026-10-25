import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLockfile, findBundlersWithMissingEntries, findMissingBundledEntries } from './check-lockfile.ts';
import type { Lockfile } from './check-lockfile.ts';

describe('findMissingBundledEntries', () => {
    it('flags a boolean bundleDependencies entry with no node_modules child', () => {
        const lock: Lockfile = {
            packages: {
                '': {},
                'node_modules/pkg': { bundleDependencies: true, dependencies: { dep: '^1.0.0' } },
            },
        };
        expect(findMissingBundledEntries(lock)).toEqual(['node_modules/pkg/node_modules/dep']);
    });

    it('flags an array bundledDependencies entry with no node_modules child', () => {
        const lock: Lockfile = {
            packages: {
                '': {},
                'node_modules/pkg': { bundledDependencies: ['dep'] },
            },
        };
        expect(findMissingBundledEntries(lock)).toEqual(['node_modules/pkg/node_modules/dep']);
    });

    it('is empty when every bundled dependency has its own entry', () => {
        const lock: Lockfile = {
            packages: {
                '': {},
                'node_modules/pkg': { bundleDependencies: true, dependencies: { dep: '^1.0.0' } },
                'node_modules/pkg/node_modules/dep': {},
            },
        };
        expect(findMissingBundledEntries(lock)).toEqual([]);
    });

    it('is empty for a lockfile with no packages', () => {
        expect(findMissingBundledEntries({})).toEqual([]);
    });
});

describe('findBundlersWithMissingEntries', () => {
    it('maps each incomplete bundler to its missing children and leaves complete ones out', () => {
        const lock: Lockfile = {
            packages: {
                '': {},
                'node_modules/incomplete': { bundleDependencies: ['a', 'b'] },
                'node_modules/incomplete/node_modules/a': {},
                'node_modules/complete': { bundleDependencies: ['c'] },
                'node_modules/complete/node_modules/c': {},
            },
        };
        expect(findBundlersWithMissingEntries(lock)).toEqual(new Map([['node_modules/incomplete', ['node_modules/incomplete/node_modules/b']]]));
    });
});

describe('checkLockfile', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'check-lockfile-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function write(content: unknown): string {
        const path = join(dir, 'package-lock.json');
        writeFileSync(path, JSON.stringify(content));
        return path;
    }

    it('fails and lists the missing entries', () => {
        const path = write({
            packages: {
                '': {},
                'node_modules/pkg': { bundleDependencies: true, dependencies: { dep: '^1.0.0' } },
            },
        });
        const result = checkLockfile([path]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('is missing 1 bundled dependency entry');
        expect(result.stderr).toContain('node_modules/pkg/node_modules/dep');
        expect(result.stderr).toContain('ci-tools repair-lockfile');
    });

    it('passes a complete lockfile', () => {
        const path = write({
            packages: {
                '': {},
                'node_modules/pkg': { bundleDependencies: true, dependencies: { dep: '^1.0.0' } },
                'node_modules/pkg/node_modules/dep': {},
            },
        });
        const result = checkLockfile([path]);
        expect(result).toEqual({ code: 0, stdout: `${path}: all bundled dependency entries are present.\n`, stderr: '' });
    });
});
