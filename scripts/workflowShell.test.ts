import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_DIR = join(import.meta.dirname, '..', '.github', 'workflows');

// Splits a workflow file into its jobs by indentation. This repo's workflows are all written in the same block
// style (jobs at two spaces, job keys at four), so a YAML parser, which would be a new dependency, is not needed.
function jobBlocks(text: string): Map<string, string> {
    const jobs = new Map<string, string>();
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line === 'jobs:');
    if (start === -1) return jobs;
    let current: string | undefined;
    for (const line of lines.slice(start + 1)) {
        const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (header) {
            current = header[1];
            jobs.set(current, '');
        } else if (current !== undefined) {
            jobs.set(current, `${jobs.get(current)}${line}\n`);
        }
    }
    return jobs;
}

describe('jobs that run in a container', () => {
    // Inside a job `container:` GitHub runs `run:` steps with `sh`, which is dash in the Playwright image, so any
    // bash feature (`set -o pipefail`, `[[ ]]`, process substitution) fails. v0.3.0 shipped exactly that bug.
    it('declare defaults.run.shell: bash', () => {
        const offenders: string[] = [];
        let containerJobs = 0;
        for (const file of readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith('.yml'))) {
            const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
            for (const [job, block] of jobBlocks(text)) {
                if (!/^ {4}container:/m.test(block)) continue;
                containerJobs += 1;
                if (!/^ {4}defaults:\n {6}run:\n {8}shell: bash\s*$/m.test(block)) {
                    offenders.push(`${file}: ${job}`);
                }
            }
        }
        // Guards the guard: if the parsing above stops finding the container jobs, this must not pass vacuously.
        expect(containerJobs).toBeGreaterThanOrEqual(2);
        expect(offenders).toEqual([]);
    });

    it('is detected by the helper when the declaration is missing', () => {
        const blocks = jobBlocks('jobs:\n  a:\n    container:\n      image: x\n    steps: []\n');
        expect(/^ {4}defaults:\n {6}run:\n {8}shell: bash\s*$/m.test(blocks.get('a') ?? '')).toBe(false);
    });
});
