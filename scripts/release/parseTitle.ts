// Parses a pull request title written as a Conventional Commit: `type(scope)?!?: description`. The title becomes the
// merge commit message, so it is the single place that decides the version bump and the release notes.

export const ALLOWED_TYPES = [
    'feat',
    'fix',
    'perf',
    'refactor',
    'build',
    'chore',
    'revert',
    'style',
    'docs',
    'ci',
    'test',
] as const;

export type CommitType = (typeof ALLOWED_TYPES)[number];

export interface ParsedTitle {
    type: CommitType;
    scope?: string;
    // True when the title has a `!` before the colon, e.g. `feat(audio)!: drop the legacy engine`.
    breaking: boolean;
    description: string;
}

export interface TitleError {
    message: string;
}

const TITLE_PATTERN = /^([A-Za-z]+)(?:\(([^()\s][^()]*)\))?(!)?: (\S.*)$/;

function isAllowedType(type: string): type is CommitType {
    return (ALLOWED_TYPES as readonly string[]).includes(type);
}

export function isTitleError(result: ParsedTitle | TitleError): result is TitleError {
    return 'message' in result;
}

export function parseTitle(title: string): ParsedTitle | TitleError {
    const allowed = ALLOWED_TYPES.join(', ');
    const match = TITLE_PATTERN.exec(title.trim());
    if (!match) {
        return {
            message:
                `"${title}" is not a Conventional Commit title. Use "type(scope)?: description" ` +
                `(add "!" before the colon for a breaking change), for example "fix(audio): stop the meter leaking". ` +
                `Allowed types: ${allowed}.`,
        };
    }
    const [, type, scope, bang, description] = match;
    // Types are lowercase on purpose: one spelling keeps the release notes and the bump table unambiguous.
    if (!isAllowedType(type)) {
        return { message: `Unknown type "${type}" in "${title}". Allowed types: ${allowed}.` };
    }
    return { type, ...(scope === undefined ? {} : { scope }), breaking: bang === '!', description };
}
