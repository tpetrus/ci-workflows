import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Every script here is a plain Node module; no DOM is ever needed.
        environment: 'node',
        include: ['scripts/**/*.test.ts'],
    },
});
