import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from './commands.ts';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-cli-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
}

const pkg = (deps: object = {}) => JSON.stringify({ version: '0.1.0-beta', dependencies: deps });

describe('check-title', () => {
    it('accepts a good title and rejects a bad one', () => {
        expect(runCommand(['check-title', 'feat(x)!: y'])).toMatchObject({ code: 0, stdout: 'feat (breaking)\n' });
        expect(runCommand(['check-title', 'fix: y']).stdout).toBe('fix\n');
        expect(runCommand(['check-title', 'nope'])).toMatchObject({ code: 1 });
        expect(runCommand(['check-title'])).toMatchObject({ code: 1, stderr: 'Missing title argument.\n' });
    });
});

describe('expected-version', () => {
    it('prints the next version', () => {
        expect(runCommand(['expected-version', '--base-version', '1.0.0', 'feat: x']).stdout).toBe('1.1.0\n');
    });

    it('fails without a base version or on a bad title', () => {
        expect(runCommand(['expected-version', 'feat: x']).code).toBe(1);
        expect(runCommand(['expected-version', '--base-version', '1.0.0', 'x']).code).toBe(1);
    });
});

describe('check-shipped', () => {
    function args(
        title: string,
        changed: string,
        headDeps: object = {},
        shippedFlags: readonly string[] = ['--shipped-prefix', 'app/', '--shipped-file', 'vite.config.ts'],
    ): string[] {
        return [
            'check-shipped',
            '--base-package',
            write('base.json', pkg()),
            '--head-package',
            write('head.json', pkg(headDeps)),
            '--changed-files',
            write('changed.txt', changed),
            ...shippedFlags,
            title,
        ];
    }

    it('passes a docs change that touches no shipped input', () => {
        expect(runCommand(args('docs: x', 'README.md\n.github/workflows/ci.yml\n')).code).toBe(0);
    });

    it('fails a ci title that changes app code or dependencies, saying which', () => {
        const result = runCommand(args('ci: x', 'app/root.tsx\n', { react: '^19' }));
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('app/root.tsx');
        expect(result.stderr).toContain('package.json dependencies');
        expect(result.stderr).toContain('releasing type');
    });

    it('lets releasing types change anything', () => {
        expect(runCommand(args('fix: x', 'app/root.tsx\n')).code).toBe(0);
    });

    it('accepts just --shipped-file with no --shipped-prefix, and vice versa', () => {
        const byFile = runCommand(args('docs: x', 'vite.config.ts\n', {}, ['--shipped-file', 'vite.config.ts']));
        expect(byFile.code).toBe(1);
        expect(byFile.stderr).toContain('vite.config.ts');
        const byPrefix = runCommand(args('docs: x', 'app/root.tsx\n', {}, ['--shipped-prefix', 'app/']));
        expect(byPrefix.code).toBe(1);
        expect(byPrefix.stderr).toContain('app/root.tsx');
    });

    it('reports missing options and a bad title', () => {
        expect(runCommand(['check-shipped', 'docs: x']).code).toBe(1);
        expect(runCommand(['check-shipped', 'bad']).code).toBe(1);
    });

    it('fails clearly when neither --shipped-prefix nor --shipped-file is given', () => {
        const result = runCommand(args('docs: x', 'app/root.tsx\n', {}, []));
        expect(result).toMatchObject({
            code: 1,
            stderr: 'Missing --shipped-prefix or --shipped-file (at least one of each is required).\n',
        });
    });
});

describe('write-version', () => {
    it('edits both files in place', () => {
        const lock = JSON.stringify({ version: '0.1.0-beta', packages: { '': { version: '0.1.0-beta' } } }, null, 2);
        const packagePath = write('package.json', `${pkg()}\n`);
        const lockPath = write('package-lock.json', `${lock}\n`);
        expect(runCommand(['write-version', '0.1.0', '--dir', dir]).code).toBe(0);
        expect(readFileSync(packagePath, 'utf8')).toBe(`${pkg().replace('0.1.0-beta', '0.1.0')}\n`);
        expect(readFileSync(lockPath, 'utf8')).toBe(`${lock.replaceAll('0.1.0-beta', '0.1.0')}\n`);
    });

    it('requires a version and refuses symbolic links', () => {
        expect(runCommand(['write-version']).code).toBe(1);
        const target = write('real.json', pkg());
        write('package-lock.json', '{}');
        try {
            symlinkSync(target, join(dir, 'package.json'));
        } catch {
            // Creating symlinks needs elevated rights on Windows; the check is exercised on Linux CI.
            return;
        }
        expect(() => runCommand(['write-version', '0.1.0', '--dir', dir])).toThrow(/symbolic link/);
    });
});

describe('notes', () => {
    const log = 'a\u001fMerge pull request #3 from x/y\u001ffix: a bug\n\u001e';

    it('prints generated notes', () => {
        const result = runCommand(['notes', '--version', '1.0.0', '--log-file', write('log.txt', log)]);
        expect(result.stdout).toBe('## Fixes\n\n- a bug (#3)\n');
    });

    it('prefers the hand-written notes file', () => {
        mkdirSync(join(dir, 'notes'));
        write('notes/v1.0.0.md', 'Hand written\n');
        const result = runCommand([
            'notes',
            '--version',
            '1.0.0',
            '--log-file',
            write('log.txt', log),
            '--notes-dir',
            join(dir, 'notes'),
        ]);
        expect(result.stdout).toBe('Hand written\n');
    });

    it('needs its options', () => {
        expect(runCommand(['notes']).code).toBe(1);
    });
});

describe('resolve-conflicts', () => {
    it('resolves version-only conflicts and rejects others', () => {
        const good = write('good.json', '<<<<<<< a\n"version": "1",\n=======\n"version": "2",\n>>>>>>> b\n');
        expect(runCommand(['resolve-conflicts', good]).code).toBe(0);
        expect(readFileSync(good, 'utf8')).toBe('"version": "2",\n');
        const bad = write('bad.json', '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n');
        expect(runCommand(['resolve-conflicts', bad]).code).toBe(1);
        expect(runCommand(['resolve-conflicts']).code).toBe(1);
    });
});

describe('usage', () => {
    it('prints help without a command and fails on an unknown one', () => {
        expect(runCommand([])).toMatchObject({ code: 0 });
        expect(runCommand(['nope'])).toMatchObject({ code: 2 });
        expect(runCommand(['nope']).stderr).toContain('Usage');
    });
});
