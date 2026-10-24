// Regression check for the installed-package path: packs this repo the way `npx github:...` does, installs the
// tarball into a throwaway project so the package lives under a real node_modules directory, and runs the
// `ci-tools` bin from there. Run it with `npm run verify:pack`.
//
// Why this exists: Node's type stripping refuses .ts files under a node_modules directory
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a bin that points at .ts source works from a checkout (the
// composite actions, `npm run check-lockfile`, vitest) but crashes the moment npx installs it. Nothing else in CI
// runs the bin from node_modules, so without this check that failure is invisible until a caller hits it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Outcome {
    code: number | null;
    output: string;
}

// Runs npm through the npm-cli.js that started this script (npm sets npm_execpath for `npm run`). npm is a .cmd shim
// on Windows, which Node refuses to spawn without a shell, and a shell would mean hand-quoting every path; running
// the same npm under the current node avoids both and uses the exact npm version the caller is on.
function npm(args: string[], cwd: string): Outcome {
    const npmCli = process.env.npm_execpath;
    if (npmCli === undefined) throw new Error('npm_execpath is not set; run this through `npm run verify:pack`.');
    const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function mustSucceed(description: string, outcome: Outcome): void {
    if (outcome.code !== 0) {
        throw new Error(`${description} failed (exit ${outcome.code}):\n${outcome.output}`);
    }
}

const failures: string[] = [];

function expectExit(description: string, actual: Outcome, expectedCode: number, expectedText: string): void {
    const ok = actual.code === expectedCode && actual.output.includes(expectedText);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${description} (exit ${actual.code})`);
    if (!ok) failures.push(`${description}: expected exit ${expectedCode} containing "${expectedText}", got:\n${actual.output}`);
}

const repoRoot = process.cwd();
const workDir = mkdtempSync(join(tmpdir(), 'ci-tools-pack-'));

try {
    // `npm pack` runs the `prepare` script, which builds the JavaScript the tarball ships.
    const packDir = join(workDir, 'pack');
    mkdirSync(packDir);
    mustSucceed('npm pack', npm(['pack', '--pack-destination', packDir], repoRoot));
    const tarball = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
    if (tarball === undefined) throw new Error(`npm pack produced no .tgz in ${packDir}`);

    const project = join(workDir, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
    mustSucceed('npm install <tarball>', npm(['install', '--no-audit', '--no-fund', join(packDir, tarball)], project));

    // A lockfile that lost a bundled dependency's entry (the exact thing check-lockfile exists to catch), and a
    // complete one.
    const brokenLock = join(project, 'broken-lock.json');
    writeFileSync(brokenLock, JSON.stringify({ packages: { '': {}, 'node_modules/pkg': { bundleDependencies: ['dep'] } } }));
    const goodLock = join(project, 'good-lock.json');
    writeFileSync(
        goodLock,
        JSON.stringify({ packages: { '': {}, 'node_modules/pkg': { bundleDependencies: ['dep'] }, 'node_modules/pkg/node_modules/dep': {} } }),
    );

    // `npm exec --no-install` resolves the bin through node_modules/.bin, the same shim npx uses.
    const ciTools = (...args: string[]): Outcome => npm(['exec', '--no', '--', 'ci-tools', ...args], project);
    expectExit('no arguments prints usage and exits 0', ciTools(), 0, 'Usage: ci-tools');
    expectExit('unknown sub-tool exits 2', ciTools('nope'), 2, 'Usage: ci-tools');
    expectExit('check-lockfile passes a complete lockfile', ciTools('check-lockfile', goodLock), 0, 'all bundled dependency entries are present');
    expectExit('check-lockfile fails an incomplete lockfile', ciTools('check-lockfile', brokenLock), 1, 'node_modules/pkg/node_modules/dep');
    expectExit('release with no command prints the release usage', ciTools('release'), 0, 'Commands:');
} finally {
    rmSync(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
    console.error(`\n${failures.join('\n\n')}`);
    process.exitCode = 1;
}
