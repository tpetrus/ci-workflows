import { describe, expect, it } from 'vitest';
import { buildReleaseNotes, parseMergeLog } from './releaseNotes.ts';

const record = (subject: string, body = '') => `abc123\u001f${subject}\u001f${body}\n\u001e`;

describe('parseMergeLog', () => {
    it('reads merge commits, whose body is the PR title', () => {
        const log = record('Merge pull request #37 from tpetrus/perf/raise-budgets', 'perf: raise budgets\n');
        expect(parseMergeLog(log)).toEqual([{ number: 37, title: 'perf: raise budgets' }]);
    });

    it('reads squash commits and skips everything else', () => {
        const log = [
            record('feat: add a thing (#12)'),
            record('chore: set version to 1.0.1'),
            record('Merge pull request #5 from a/b', ''),
        ].join('');
        expect(parseMergeLog(log)).toEqual([{ number: 12, title: 'feat: add a thing' }]);
    });

    it('returns nothing for an empty log', () => {
        expect(parseMergeLog('')).toEqual([]);
    });
});

describe('buildReleaseNotes', () => {
    it('groups by section and skips docs, ci and test', () => {
        const notes = buildReleaseNotes([
            { number: 1, title: 'feat(audio): add a meter' },
            { number: 2, title: 'fix: stop a leak' },
            { number: 3, title: 'perf: faster frames' },
            { number: 4, title: 'build(deps): bump react' },
            { number: 5, title: 'docs: explain things' },
            { number: 6, title: 'ci: tweak a workflow' },
            { number: 7, title: 'test: more specs' },
            { number: 8, title: 'feat(ui)!: new layout' },
            { number: 9, title: 'Fixed some stuff' },
        ]);
        expect(notes).toBe(
            [
                '## Features',
                '',
                '- **audio:** add a meter (#1)',
                '- **Breaking:** **ui:** new layout (#8)',
                '',
                '## Fixes',
                '',
                '- stop a leak (#2)',
                '',
                '## Performance',
                '',
                '- faster frames (#3)',
                '',
                '## Other',
                '',
                '- **deps:** bump react (#4)',
                '- Fixed some stuff (#9)',
                '',
            ].join('\n'),
        );
    });

    it('says so when nothing user-facing changed', () => {
        expect(buildReleaseNotes([{ number: 1, title: 'docs: x' }])).toBe('No user-facing changes.\n');
    });

    it('uses hand-written notes instead when given', () => {
        expect(buildReleaseNotes([{ number: 1, title: 'fix: x' }], 'Custom notes\n')).toBe('Custom notes\n');
    });
});
