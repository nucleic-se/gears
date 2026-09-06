import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['**/*.test.ts'],
        exclude: [...configDefaults.exclude, 'examples/agentic-harness/**'],
    },
});
