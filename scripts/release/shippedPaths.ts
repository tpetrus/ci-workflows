import { isDeepStrictEqual } from 'node:util';

// A sane generic default for any npm project: these keys change what gets installed, which always needs a release.
// The paths and files that change what a deployed project does vary per caller (an Astro portfolio, a React Router
// SPA, future subdomain projects), so they are not hardcoded here; the caller passes them to shippedChanges().
const SHIPPED_PACKAGE_KEYS = ['dependencies', 'devDependencies'] as const;

interface PackageJsonLike {
    dependencies?: unknown;
    devDependencies?: unknown;
}

export interface ShippedInput {
    changedFiles: readonly string[];
    basePackageJson: string;
    headPackageJson: string;
    // Everything whose change alters what the deployed project does. A change to any of these needs a release, so a
    // title of type docs, ci or test (which release nothing) must not touch them.
    shippedPrefixes: readonly string[];
    shippedFiles: readonly string[];
}

// Returns a human-readable reason for each shipped input that changed; empty means nothing shipped changed. The
// package.json comparison is on the parsed objects, so a version bump or a scripts edit is not a shipped change but a
// dependency edit is.
export function shippedChanges({
    changedFiles,
    basePackageJson,
    headPackageJson,
    shippedPrefixes,
    shippedFiles,
}: ShippedInput): string[] {
    const reasons: string[] = [];
    for (const file of changedFiles) {
        if (shippedPrefixes.some((prefix) => file.startsWith(prefix)) || shippedFiles.includes(file)) {
            reasons.push(file);
        }
    }
    const base = JSON.parse(basePackageJson) as PackageJsonLike;
    const head = JSON.parse(headPackageJson) as PackageJsonLike;
    for (const key of SHIPPED_PACKAGE_KEYS) {
        if (!isDeepStrictEqual(base[key], head[key])) reasons.push(`package.json ${key}`);
    }
    return reasons;
}
