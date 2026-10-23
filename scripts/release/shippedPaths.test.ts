import { describe, expect, it } from 'vitest';
import { shippedChanges } from './shippedPaths.ts';

const pkg = (extra: object = {}) =>
    JSON.stringify({
        version: '1.0.0',
        scripts: { a: 'x' },
        dependencies: { react: '^19' },
        devDependencies: {},
        ...extra,
    });

const SHIPPED_PREFIXES = ['app/', 'public/'];
const SHIPPED_FILES = ['vite.config.ts', 'react-router.config.ts', 'wrangler.jsonc'];

describe('shippedChanges', () => {
    it('is empty for docs, workflows and scripts', () => {
        expect(
            shippedChanges({
                changedFiles: ['README.md', '.github/workflows/ci.yml', 'scripts/release/cli.ts', 'e2e/visual.spec.ts'],
                basePackageJson: pkg(),
                headPackageJson: pkg(),
                shippedPrefixes: SHIPPED_PREFIXES,
                shippedFiles: SHIPPED_FILES,
            }),
        ).toEqual([]);
    });

    it('flags paths and files matching the caller-supplied prefixes and files', () => {
        const changedFiles = [
            'app/root.tsx',
            'public/fonts/a.woff2',
            'vite.config.ts',
            'react-router.config.ts',
            'wrangler.jsonc',
            'application.md',
        ];
        expect(
            shippedChanges({
                changedFiles,
                basePackageJson: pkg(),
                headPackageJson: pkg(),
                shippedPrefixes: SHIPPED_PREFIXES,
                shippedFiles: SHIPPED_FILES,
            }),
        ).toEqual(changedFiles.slice(0, 5));
    });

    it('uses a different caller-supplied set of prefixes and files', () => {
        const changedFiles = ['src/pages/index.astro', 'astro.config.mjs', 'app/root.tsx'];
        expect(
            shippedChanges({
                changedFiles,
                basePackageJson: pkg(),
                headPackageJson: pkg(),
                shippedPrefixes: ['src/'],
                shippedFiles: ['astro.config.mjs'],
            }),
        ).toEqual(['src/pages/index.astro', 'astro.config.mjs']);
    });

    it('ignores version and script edits in package.json', () => {
        expect(
            shippedChanges({
                changedFiles: ['package.json'],
                basePackageJson: pkg(),
                headPackageJson: pkg({ version: '1.0.1', scripts: { b: 'y' } }),
                shippedPrefixes: SHIPPED_PREFIXES,
                shippedFiles: SHIPPED_FILES,
            }),
        ).toEqual([]);
    });

    it('ignores reformatting because it compares parsed JSON', () => {
        expect(
            shippedChanges({
                changedFiles: ['package.json'],
                basePackageJson: pkg(),
                headPackageJson: JSON.stringify(JSON.parse(pkg()), null, 8),
                shippedPrefixes: SHIPPED_PREFIXES,
                shippedFiles: SHIPPED_FILES,
            }),
        ).toEqual([]);
    });

    it('flags dependency and devDependency changes', () => {
        expect(
            shippedChanges({
                changedFiles: ['package.json'],
                basePackageJson: pkg(),
                headPackageJson: pkg({ dependencies: { react: '^20' }, devDependencies: { vitest: '^5' } }),
                shippedPrefixes: SHIPPED_PREFIXES,
                shippedFiles: SHIPPED_FILES,
            }),
        ).toEqual(['package.json dependencies', 'package.json devDependencies']);
    });
});
