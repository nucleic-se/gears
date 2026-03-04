import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AIActionRegistry } from '../../src/core/ai/AIActionRegistry.js';

describe('AIActionRegistry', () => {
    it('validates params with zod schema', async () => {
        const registry = new AIActionRegistry({} as any);
        const action = {
            name: 'add',
            description: 'add',
            schema: z.object({ a: z.number(), b: z.number() }),
            handler: async (params: any) => params.a + params.b
        };

        registry.register(action);

        await expect(registry.execute('add', { a: 1, b: 2 })).resolves.toBe(3);
        await expect(registry.execute('add', { a: 'x', b: 2 })).rejects.toThrow('Invalid params');
    });

    it('skips validation for non-object schema', async () => {
        const registry = new AIActionRegistry({} as any);
        const action = {
            name: 'echo',
            description: 'echo',
            schema: 'description only',
            handler: async (params: any) => params
        };

        registry.register(action);

        await expect(registry.execute('echo', { ok: true })).resolves.toEqual({ ok: true });
    });
});
