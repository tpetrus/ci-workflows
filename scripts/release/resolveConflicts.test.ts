import { describe, expect, it } from 'vitest';
import { resolveVersionConflicts } from './resolveConflicts.ts';

describe('resolveVersionConflicts', () => {
    it('takes main (theirs) when only version lines conflict', () => {
        const text = [
            '{',
            '<<<<<<< HEAD',
            '  "version": "1.0.1",',
            '=======',
            '  "version": "1.1.0",',
            '>>>>>>> origin/main',
            '  "name": "x"',
            '}',
        ].join('\n');
        expect(resolveVersionConflicts(text)).toEqual({
            resolved: true,
            text: ['{', '  "version": "1.1.0",', '  "name": "x"', '}'].join('\n'),
        });
    });

    it('handles diff3 markers and several blocks', () => {
        const block = (ours: string, theirs: string) =>
            [
                '<<<<<<< HEAD',
                `      "version": "${ours}"`,
                '||||||| base',
                '      "version": "1.0.0"',
                '=======',
                `      "version": "${theirs}"`,
                '>>>>>>> origin/main',
            ].join('\n');
        const result = resolveVersionConflicts([block('1.0.1', '1.1.0'), block('1.0.1', '1.1.0')].join('\n'));
        expect(result).toEqual({
            resolved: true,
            text: ['      "version": "1.1.0"', '      "version": "1.1.0"'].join('\n'),
        });
    });

    it('refuses a conflict that touches anything else', () => {
        const text = [
            '<<<<<<< HEAD',
            '  "version": "1.0.1",',
            '  "dep": "^2",',
            '=======',
            '  "version": "1.1.0",',
            '>>>>>>> m',
        ].join('\n');
        expect(resolveVersionConflicts(text)).toEqual({ resolved: false });
    });

    it('refuses an unterminated block', () => {
        expect(resolveVersionConflicts('<<<<<<< HEAD\n  "version": "1"')).toEqual({ resolved: false });
    });

    it('returns a file without conflicts unchanged', () => {
        expect(resolveVersionConflicts('{}\n')).toEqual({ resolved: true, text: '{}\n' });
    });
});
