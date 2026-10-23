import { describe, expect, it } from 'vitest';
import { setLockfileVersion, setPackageVersion } from './versionFiles.ts';

const PACKAGE = `{
  "name": "x",
  "version": "0.1.0-beta",
  "dependencies": {
    "dep": "^1.0.0"
  }
}
`;

const LOCK = `{
  "name": "x",
  "version": "0.1.0-beta",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "x",
      "version": "0.1.0-beta",
      "dependencies": {
        "dep": "^1.0.0"
      }
    },
    "node_modules/dep": {
      "version": "1.2.3"
    }
  }
}
`;

describe('setPackageVersion', () => {
    it('changes only the version line', () => {
        expect(setPackageVersion(PACKAGE, '1.0.0')).toBe(PACKAGE.replace('0.1.0-beta', '1.0.0'));
    });

    it('throws when there is no version field', () => {
        expect(() => setPackageVersion('{"name":"x"}', '1.0.0')).toThrow(/No "version"/);
    });
});

describe('setLockfileVersion', () => {
    it('changes the top-level and root-package versions, not dependencies', () => {
        const result = setLockfileVersion(LOCK, '0.1.0');
        expect(result).toBe(LOCK.replaceAll('0.1.0-beta', '0.1.0'));
        expect(result).toContain('"version": "1.2.3"');
    });

    it('throws when the root package entry is missing', () => {
        expect(() => setLockfileVersion('{"version":"1.0.0"}', '2.0.0')).toThrow(/packages/);
    });

    it('throws when the root entry has no version', () => {
        const lock = '{"version":"1.0.0","packages":{"":{"name":"x"},"node_modules/a":{"version":"3.0.0"}}}';
        expect(() => setLockfileVersion(lock, '2.0.0')).toThrow(/Edit did not set/);
    });
});
