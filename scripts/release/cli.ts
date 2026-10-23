// Entry point for the release workflows: `node scripts/release/cli.ts <command> ...` (Node 24 strips the types, so no
// build step is needed). The logic lives in commands.ts, where it has specs; this file only does process I/O.
import { runCommand } from './commands.ts';

try {
    const { code, stdout, stderr } = runCommand(process.argv.slice(2));
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = code;
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
