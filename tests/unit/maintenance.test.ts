import { describe, it, expect, vi, afterEach } from 'vitest';
import { SharedDatabase } from '../../src/core/infra/SharedDatabase.js';
import { ScheduledJobRegistrar } from '../../src/core/schedule/ScheduledJobRegistrar.js';
import type { IScheduler } from '../../src/core/interfaces.js';
import type { IQueue } from '../../src/core/queue/interfaces.js';

afterEach(() => vi.useRealTimers());

describe('maintenance regressions', () => {
    it('sweeps unread expired records in the shared store and stops its timer on close', async () => {
        vi.useFakeTimers();
        const shared = new SharedDatabase(':memory:');
        const store = shared.createStore();
        await store.set('expired', 1, 1);
        await store.set('persistent', 2);
        await vi.advanceTimersByTimeAsync(300_000);
        // sweep() counts physical rows; scan()/get() alone would only prove lazy expiration.
        expect((store as unknown as { sweep(): number }).sweep()).toBe(0);
        expect(await store.get('persistent')).toBe(2);
        shared.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('allows corrected registration after the scheduler rejects a definition', () => {
        const schedule = vi.fn().mockImplementationOnce(() => { throw new Error('Invalid cron'); });
        const registrar = new ScheduledJobRegistrar({ schedule } as unknown as IScheduler, {} as IQueue);
        const definition = { id: 'task', cron: 'invalid', jobType: 'task', payload: null };
        expect(() => registrar.register(definition)).toThrow('Invalid cron');
        expect(registrar.list()).toEqual([]);
        registrar.register({ ...definition, cron: '* * * * *' });
        expect(registrar.list()).toHaveLength(1);
    });
});
