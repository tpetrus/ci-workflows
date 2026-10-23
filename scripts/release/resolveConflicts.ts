// Resolves a merge conflict that is only about `"version"` lines. The version bot merges main into every open PR
// branch; if main released in the meantime, package.json and package-lock.json conflict on exactly those lines. The bot
// then takes main's side and writes the right version on top. A conflict touching anything else is a human's to solve.

const VERSION_LINE = /^\s*"version":\s*"[^"]*",?\s*$/;

export type Resolution = { resolved: true; text: string } | { resolved: false };

// Takes the incoming ("theirs", main's) side of every conflict block, provided every line on both sides of every block
// is a version line. Handles both the default and the diff3 marker styles.
export function resolveVersionConflicts(text: string): Resolution {
    const out: string[] = [];
    let state: 'outside' | 'ours' | 'base' | 'theirs' = 'outside';
    let ours: string[] = [];
    let theirs: string[] = [];
    for (const line of text.split('\n')) {
        if (state === 'outside') {
            if (line.startsWith('<<<<<<< ')) {
                state = 'ours';
                ours = [];
                theirs = [];
            } else {
                out.push(line);
            }
        } else if (line.startsWith('||||||| ') && state === 'ours') {
            // Lines in the base section of a diff3 conflict are ignored: they are the common ancestor.
            state = 'base';
        } else if (line.startsWith('=======') && state !== 'theirs') {
            state = 'theirs';
        } else if (line.startsWith('>>>>>>> ') && state === 'theirs') {
            if (![...ours, ...theirs].every((candidate) => VERSION_LINE.test(candidate))) return { resolved: false };
            out.push(...theirs);
            state = 'outside';
        } else if (state === 'ours') {
            ours.push(line);
        } else if (state === 'theirs') {
            theirs.push(line);
        }
    }
    // An unterminated block means the file is not a well-formed conflict, so leave it alone.
    if (state !== 'outside') return { resolved: false };
    return { resolved: true, text: out.join('\n') };
}
