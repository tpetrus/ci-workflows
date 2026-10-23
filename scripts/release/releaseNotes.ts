import { isTitleError, parseTitle } from './parseTitle.ts';

export interface MergedPullRequest {
    number: number;
    title: string;
}

const SECTIONS = [
    { heading: 'Features', types: ['feat'] },
    { heading: 'Fixes', types: ['fix'] },
    { heading: 'Performance', types: ['perf'] },
    { heading: 'Other', types: ['refactor', 'build', 'chore', 'revert', 'style'] },
] as const;

const NO_CHANGES = 'No user-facing changes.';

// Separators that `git log --format=%H%x1f%s%x1f%b%x1e` puts between fields and between commits. Control characters
// cannot appear in a commit message, so splitting on them is safe.
const FIELD = '\u001f';
const RECORD = '\u001e';

// Pulls the merged pull requests out of `git log --first-parent --format=%H%x1f%s%x1f%b%x1e`. A merge commit has the
// subject "Merge pull request #N from owner/branch" and the PR title as its body; a squash commit has the title as its
// subject, ending in "(#N)". Any other commit (a direct push, the version bot) is not a pull request and is skipped.
export function parseMergeLog(log: string): MergedPullRequest[] {
    const pullRequests: MergedPullRequest[] = [];
    for (const record of log.split(RECORD)) {
        const [, subject = '', body = ''] = record.trim().split(FIELD);
        const merge = /^Merge pull request #(\d+) from /.exec(subject);
        if (merge) {
            const title = body.trim().split('\n')[0];
            if (title) pullRequests.push({ number: Number(merge[1]), title });
            continue;
        }
        const squash = /^(.+) \(#(\d+)\)$/.exec(subject);
        if (squash) pullRequests.push({ number: Number(squash[2]), title: squash[1] });
    }
    return pullRequests;
}

// Markdown for a GitHub release. A hand-written `.github/release-notes/v<version>.md` replaces the generated text
// entirely, for releases that deserve more than a list of titles.
export function buildReleaseNotes(pullRequests: readonly MergedPullRequest[], override?: string): string {
    if (override !== undefined) return override;
    const grouped = new Map<string, string[]>(SECTIONS.map((section) => [section.heading, []]));
    for (const { number, title } of pullRequests) {
        const parsed = parseTitle(title);
        // A title that is not conventional still shipped something, so it is listed under Other rather than dropped.
        const type = isTitleError(parsed) ? 'chore' : parsed.type;
        const section = SECTIONS.find((candidate) => (candidate.types as readonly string[]).includes(type));
        // docs, ci and test have no section: they change nothing that ships.
        if (!section) continue;
        const text = isTitleError(parsed) ? title : parsed.description;
        const scope = !isTitleError(parsed) && parsed.scope ? `**${parsed.scope}:** ` : '';
        const breaking = !isTitleError(parsed) && parsed.breaking ? '**Breaking:** ' : '';
        grouped.get(section.heading)?.push(`- ${breaking}${scope}${text} (#${number})`);
    }
    const blocks = SECTIONS.flatMap(({ heading }) => {
        const lines = grouped.get(heading) ?? [];
        return lines.length > 0 ? [`## ${heading}\n\n${lines.join('\n')}`] : [];
    });
    return `${blocks.length > 0 ? blocks.join('\n\n') : NO_CHANGES}\n`;
}
