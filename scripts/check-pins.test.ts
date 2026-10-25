import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPins, hasExactReleaseTag, isCiWorkflowsRef, parseUsesValue, scanContent } from './check-pins.ts';

const WORKFLOW = 'tpetrus/ci-workflows/.github/workflows/node-ci.yml';

describe('parseUsesValue', () => {
    it.each([
        ['    uses: a/b@v1', 'a/b@v1'],
        ['      - uses: a/b@v1', 'a/b@v1'],
        ['    uses: "a/b@v1"', 'a/b@v1'],
        ["    uses: 'a/b@v1'", 'a/b@v1'],
        ['    uses: a/b@v1 # a comment', 'a/b@v1'],
        ['    uses: "a/b@v1" # a comment', 'a/b@v1'],
        ['    uses: a/b@v1\r', 'a/b@v1'],
        ['    uses: "a/b@v1', 'a/b@v1'],
        ['    uses: a/b@v1#frag', 'a/b@v1#frag'],
        ['uses:', ''],
    ])('reads %j', (line, expected) => {
        expect(parseUsesValue(line)).toBe(expected);
    });

    it('returns undefined for lines without uses', () => {
        expect(parseUsesValue('    run: echo uses: a/b@v1')).toBeUndefined();
    });
});

describe('isCiWorkflowsRef', () => {
    it.each([
        WORKFLOW + '@v0.1.4',
        'tpetrus/ci-workflows/actions/setup@v0.1.4',
        'tpetrus/ci-workflows@v0.1.4',
        'tpetrus/ci-workflows',
        'TPetrus/CI-Workflows/actions/setup@main',
    ])('matches %s', (uses) => {
        expect(isCiWorkflowsRef(uses)).toBe(true);
    });

    it.each([
        '$/actions/setup',
        './actions/setup',
        'docker://alpine:3',
        'actions/checkout@v7',
        'tpetrus/other/actions/setup@main',
        'someone/ci-workflows@main',
        'tpetrus',
        '',
    ])('ignores %j', (uses) => {
        expect(isCiWorkflowsRef(uses)).toBe(false);
    });
});

describe('hasExactReleaseTag', () => {
    it.each(['x@v0.1.4', 'x@v10.20.30'])('accepts %s', (uses) => {
        expect(hasExactReleaseTag(uses)).toBe(true);
    });

    it.each([
        ['a missing ref', 'tpetrus/ci-workflows/actions/setup'],
        ['v1', 'x@v1'],
        ['v1.2', 'x@v1.2'],
        ['main', 'x@main'],
        ['a SHA', 'x@3d3c42e5aac5ba805825da76410c181273ba90b1'],
        ['a prerelease', 'x@v1.2.3-rc.1'],
        ['no v prefix', 'x@1.2.3'],
    ])('rejects %s', (_name, uses) => {
        expect(hasExactReleaseTag(uses)).toBe(false);
    });
});

describe('scanContent', () => {
    it('reports offenders with 1-based line numbers', () => {
        const content = ['jobs:', '  ci:', `    uses: ${WORKFLOW}@v1`].join('\n');
        expect(scanContent('ci.yml', content)).toEqual({
            offenders: [{ file: 'ci.yml', line: 3, uses: `${WORKFLOW}@v1` }],
            skipped: [],
            pinned: 0,
        });
    });

    it('counts exact tags as pinned', () => {
        expect(scanContent('ci.yml', `    uses: ${WORKFLOW}@v0.1.4 # pinned`)).toEqual({
            offenders: [],
            skipped: [],
            pinned: 1,
        });
    });

    it('handles CRLF, quotes, step dashes and a missing ref together', () => {
        const content = [`  - uses: "${WORKFLOW}@main"`, `    uses: 'tpetrus/ci-workflows/actions/setup'`, ''].join(
            '\r\n',
        );
        const { offenders } = scanContent('a.yml', content);
        expect(offenders.map((o) => o.uses)).toEqual([`${WORKFLOW}@main`, 'tpetrus/ci-workflows/actions/setup']);
    });

    it('skips a line carrying the zizmor marker, and only that line', () => {
        const content = [
            `    uses: ${WORKFLOW}@main # zizmor: ignore[unpinned-uses] dogfooding`,
            `    uses: ${WORKFLOW}@main`,
        ].join('\n');
        const result = scanContent('self.yml', content);
        expect(result.skipped).toEqual([{ file: 'self.yml', line: 1, uses: `${WORKFLOW}@main` }]);
        expect(result.offenders).toEqual([{ file: 'self.yml', line: 2, uses: `${WORKFLOW}@main` }]);
    });

    it('counts a pinned line as pinned even when it carries the marker', () => {
        const result = scanContent('a.yml', `    uses: ${WORKFLOW}@v0.1.4 # zizmor: ignore[unpinned-uses] x`);
        expect(result).toEqual({ offenders: [], skipped: [], pinned: 1 });
    });

    it('ignores other owners, $/, ./ and docker refs', () => {
        const content = [
            '    uses: actions/checkout@v7',
            '    uses: $/actions/setup',
            '    uses: ./local',
            '    uses: docker://alpine:3',
        ].join('\n');
        expect(scanContent('a.yml', content)).toEqual({ offenders: [], skipped: [], pinned: 0 });
    });
});

describe('checkPins', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'check-pins-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function write(relative: string, content: string): string {
        const path = join(dir, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        return path;
    }

    it('passes with a summary when every ref is an exact tag', () => {
        const file = write('ci.yml', `    uses: ${WORKFLOW}@v0.1.4\n`);
        const result = checkPins([file]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('1 tpetrus/ci-workflows ref(s) pinned');
        expect(result.stderr).toBe('');
    });

    it('fails with path:line, the uses value and a fix hint', () => {
        const file = write('ci.yml', `jobs:\n  ci:\n    uses: ${WORKFLOW}@v1\n`);
        const result = checkPins([file]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${file}:3: ${WORKFLOW}@v1`);
        expect(result.stderr).toContain('pin an exact release tag such as @vX.Y.Z');
        expect(result.stderr).toContain('README, Versioning');
    });

    it('reports suppressed lines as skipped and still passes', () => {
        const file = write('self.yml', `    uses: ${WORKFLOW}@main # zizmor: ignore[unpinned-uses] dogfood\n`);
        const result = checkPins([file]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`skipped (zizmor ignore marker) ${file}:1: ${WORKFLOW}@main`);
        expect(result.stdout).toContain('1 skipped');
    });

    it('still lists skipped lines when another ref fails', () => {
        const file = write(
            'mix.yml',
            `    uses: ${WORKFLOW}@main # zizmor: ignore[unpinned-uses] x\n    uses: ${WORKFLOW}@main\n`,
        );
        const result = checkPins([file]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`${file}:1`);
        expect(result.stderr).toContain(`${file}:2`);
    });

    it('scans directories recursively for .yml and .yaml only', () => {
        write('a/one.yml', `    uses: ${WORKFLOW}@v1\n`);
        write('a/b/two.yaml', `    uses: ${WORKFLOW}@main\n`);
        write('a/b/ignored.txt', `    uses: ${WORKFLOW}@main\n`);
        const result = checkPins([dir]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('one.yml:1');
        expect(result.stderr).toContain('two.yaml:1');
        expect(result.stderr).not.toContain('ignored.txt');
    });

    it('accepts several paths', () => {
        const good = write('good.yml', `    uses: ${WORKFLOW}@v0.1.4\n`);
        const bad = write('bad.yml', `    uses: ${WORKFLOW}@v1\n`);
        expect(checkPins([good]).code).toBe(0);
        expect(checkPins([good, bad]).code).toBe(1);
    });

    it('exits 2 for a path that does not exist', () => {
        const result = checkPins([join(dir, 'nope')]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('no such file or directory');
    });

    it('defaults to .github relative to the working directory', () => {
        write('.github/workflows/ci.yml', `    uses: ${WORKFLOW}@v1\n`);
        const previous = process.cwd();
        process.chdir(dir);
        try {
            expect(checkPins([]).code).toBe(1);
        } finally {
            process.chdir(previous);
        }
    });
});
