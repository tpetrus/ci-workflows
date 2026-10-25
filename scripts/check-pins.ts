// Fails when a workflow or action references tpetrus/ci-workflows with anything but an exact `vX.Y.Z` release tag.
// zizmor's `unpinned-uses` policy for callers is `"tpetrus/*": ref-pin`, which accepts any ref (`@v1`, `@main`, ...),
// so Dependabot can rewrite an exact tag to the legacy mutable `v1` and nothing fails. This closes that gap with a
// line-based scan of `uses:` values, so it needs no YAML parser and no install.
// Usage: node scripts/check-pins.ts [path ...]   (files, or directories scanned recursively; default .github)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CheckPinsResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface UsesRef {
    file: string;
    line: number;
    uses: string;
}

export interface ScanResult {
    offenders: UsesRef[];
    skipped: UsesRef[];
    // Count of `uses:` lines that point at tpetrus/ci-workflows and carry an exact release tag.
    pinned: number;
}

// The marker zizmor itself honors, reused so there is one place to justify a deliberately unpinned ref.
const SUPPRESSION_MARKER = '# zizmor: ignore[unpinned-uses]';

const EXACT_RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.*)$/;
const DEFAULT_PATH = '.github';

// Returns the value of a `uses:` line without quotes or a trailing comment, or undefined when the line has no `uses:`.
// A trailing `\r` (CRLF files) is dropped first so it never ends up in the value.
export function parseUsesValue(line: string): string | undefined {
    const match = USES_LINE.exec(line.replace(/\r$/, ''));
    if (match === null) return undefined;
    const rest = (match[1] ?? '').trim();
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
        const end = rest.indexOf(quote, 1);
        return end === -1 ? rest.slice(1) : rest.slice(1, end);
    }
    // In YAML a comment starts at a `#` preceded by whitespace; a `#` inside a value is part of it.
    return rest.replace(/\s+#.*$/, '');
}

// True when `uses` targets this repo in any form (reusable workflow, composite action or the bare repo). GitHub
// compares owner and repository case-insensitively, so this does too. `$/...`, `./...`, `docker://...` and other
// owners never match.
export function isCiWorkflowsRef(uses: string): boolean {
    const at = uses.lastIndexOf('@');
    const target = at === -1 ? uses : uses.slice(0, at);
    const [owner, repo] = target.split('/');
    return owner?.toLowerCase() === 'tpetrus' && repo?.toLowerCase() === 'ci-workflows';
}

// A missing `@ref` is not a pin, so it fails too.
export function hasExactReleaseTag(uses: string): boolean {
    const at = uses.lastIndexOf('@');
    return at !== -1 && EXACT_RELEASE_TAG.test(uses.slice(at + 1));
}

// Scans one file's text. Line numbers are 1-based.
export function scanContent(file: string, content: string): ScanResult {
    const result: ScanResult = { offenders: [], skipped: [], pinned: 0 };
    content.split('\n').forEach((line, index) => {
        const uses = parseUsesValue(line);
        if (uses === undefined || !isCiWorkflowsRef(uses)) return;
        const ref: UsesRef = { file, line: index + 1, uses };
        if (hasExactReleaseTag(uses)) result.pinned += 1;
        else if (line.includes(SUPPRESSION_MARKER)) result.skipped.push(ref);
        else result.offenders.push(ref);
    });
    return result;
}

// Workflow and action files under `path`: the file itself, or every .yml/.yaml below a directory, in a stable order.
function collectFiles(path: string): string[] {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => {
            const child = join(path, entry.name);
            if (entry.isDirectory()) return collectFiles(child);
            return /\.ya?ml$/.test(entry.name) ? [child] : [];
        });
}

// Scans each path in `argv` (default `.github`). Returns a result rather than printing and exiting directly, so the
// CLI wrapper below and the specs can both run it. A path that does not exist is an error (exit 2), not a pass, so a
// typo in a workflow cannot silently disable the check.
export function checkPins(argv: readonly string[]): CheckPinsResult {
    const paths = argv.length > 0 ? argv : [DEFAULT_PATH];
    const missing = paths.filter((path) => !existsSync(path));
    if (missing.length > 0) {
        const lines = missing.map((path) => `${path}: no such file or directory`);
        return { code: 2, stdout: '', stderr: `${lines.join('\n')}\n` };
    }
    const total: ScanResult = { offenders: [], skipped: [], pinned: 0 };
    for (const file of paths.flatMap(collectFiles)) {
        const scan = scanContent(file, readFileSync(file, 'utf8'));
        total.offenders.push(...scan.offenders);
        total.skipped.push(...scan.skipped);
        total.pinned += scan.pinned;
    }
    const skippedLines = total.skipped.map(
        (ref) => `skipped (zizmor ignore marker) ${ref.file}:${ref.line}: ${ref.uses}\n`,
    );
    if (total.offenders.length > 0) {
        const lines = [
            ...total.offenders.map((ref) => `${ref.file}:${ref.line}: ${ref.uses}`),
            '',
            'Each reference to tpetrus/ci-workflows above is not an exact release tag.',
            'Fix: pin an exact release tag such as @vX.Y.Z; see the ci-workflows README, Versioning.',
        ];
        return { code: 1, stdout: skippedLines.join(''), stderr: `${lines.join('\n')}\n` };
    }
    const summary = `${paths.join(' ')}: ${total.pinned} tpetrus/ci-workflows ref(s) pinned to an exact release tag, ${total.skipped.length} skipped.\n`;
    return { code: 0, stdout: `${skippedLines.join('')}${summary}`, stderr: '' };
}

// Only runs when this module is the Node entry point, so the logic above stays testable without process.exit (the
// same split check-lockfile.ts uses). pathToFileURL is needed for this comparison to hold on Windows.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { code, stdout, stderr } = checkPins(process.argv.slice(2));
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = code;
}
