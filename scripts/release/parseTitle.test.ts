import { describe, expect, it } from 'vitest';
import { ALLOWED_TYPES, isTitleError, parseTitle } from './parseTitle.ts';

describe('parseTitle', () => {
    it('parses a plain title', () => {
        expect(parseTitle('feat: add a visualizer')).toEqual({
            type: 'feat',
            breaking: false,
            description: 'add a visualizer',
        });
    });

    it('parses a scope and a breaking marker', () => {
        expect(parseTitle('fix(audio)!: drop the legacy engine')).toEqual({
            type: 'fix',
            scope: 'audio',
            breaking: true,
            description: 'drop the legacy engine',
        });
    });

    it('accepts the scopes Dependabot generates', () => {
        expect(parseTitle('build(deps-dev): bump vitest from 5.0.4 to 5.0.5')).toMatchObject({
            type: 'build',
            scope: 'deps-dev',
        });
    });

    it.each(ALLOWED_TYPES)('accepts the %s type', (type) => {
        expect(isTitleError(parseTitle(`${type}: something`))).toBe(false);
    });

    it.each(['', 'add a thing', 'feat add a thing', 'feat:missing space', 'feat(): empty scope', 'feat: ', '(x): y'])(
        'rejects the malformed title %j',
        (title) => {
            const result = parseTitle(title);
            expect(isTitleError(result)).toBe(true);
            expect(isTitleError(result) && result.message).toContain(ALLOWED_TYPES.join(', '));
        },
    );

    it('rejects an unknown or differently cased type, naming the allowed ones', () => {
        for (const title of ['wip: stuff', 'Feat: stuff']) {
            const result = parseTitle(title);
            expect(isTitleError(result) && result.message).toMatch(/Unknown type/);
            expect(isTitleError(result) && result.message).toContain(ALLOWED_TYPES.join(', '));
        }
    });
});
