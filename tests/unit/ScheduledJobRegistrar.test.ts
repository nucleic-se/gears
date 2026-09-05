import { describe, expect, it, vi } from 'vitest';

import type { IScheduler } from '../../src/core/interfaces.js';
import type { IQueue } from '../../src/core/queue/interfaces.js';
import { ScheduledJobRegistrar } from '../../src/core/schedule/ScheduledJobRegistrar.js';

function harness() {
    let callback: (() => Promise<void>) | undefined;
    const scheduler = {
        schedule: vi.fn((_cron, task) => { callback = async () => { await task(); }; }),
        unschedule: vi.fn(),
        list: vi.fn(async () => []),
        stopAll: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
    } as IScheduler;
    const queue = { add: vi.fn(async () => ({ id: 'job-1' })) } as unknown as IQueue;
    const now = () => new Date('2026-08-27T04:00:00.789Z');
    const registrar = new ScheduledJobRegistrar(scheduler, queue, now);
    return { registrar, scheduler, queue, run: async () => callback?.() };
}

describe('ScheduledJobRegistrar', () => {
    it('turns a cron occurrence into a durable job envelope', async () => {
        const h = harness();
        h.registrar.register({
            id: 'calendar:david:morning',
            cron: '0 6 * * 1-6',
            jobType: 'calendar.generate-digest',
            payload: { userSlug: 'david', period: 'today-and-rest-of-week' },
            jobOptions: { maxRetries: 3 },
            lockTtlMs: 60_000,
        });

        expect(h.scheduler.schedule).toHaveBeenCalledWith(
            '0 6 * * 1-6', expect.any(Function), 'calendar:david:morning', { lockTtlMs: 60_000 },
        );
        await h.run();
        expect(h.queue.add).toHaveBeenCalledWith(
            'calendar.generate-digest',
            {
                occurrence: {
                    scheduleId: 'calendar:david:morning',
                    scheduledFor: '2026-08-27T04:00:00.000Z',
                    occurrenceId: 'calendar:david:morning:2026-08-27T04:00:00.000Z',
                },
                payload: { userSlug: 'david', period: 'today-and-rest-of-week' },
            },
            { maxRetries: 3 },
        );
    });

    it('rejects duplicate identities and unregisters known schedules', () => {
        const h = harness();
        const definition = { id: 'digest', cron: '0 6 * * *', jobType: 'digest', payload: null };
        h.registrar.register(definition);
        expect(() => h.registrar.register(definition)).toThrow('already registered');

        h.registrar.unregister('missing');
        expect(h.scheduler.unschedule).not.toHaveBeenCalled();
        h.registrar.unregister('digest');
        expect(h.scheduler.unschedule).toHaveBeenCalledWith('digest');
    });

    it('fails early for incomplete definitions', () => {
        const h = harness();
        expect(() => h.registrar.register({ id: ' ', cron: '* * * * *', jobType: 'x', payload: null }))
            .toThrow('id must not be empty');
        expect(() => h.registrar.register({ id: 'x', cron: ' ', jobType: 'x', payload: null }))
            .toThrow('cron must not be empty');
        expect(() => h.registrar.register({ id: 'x', cron: '* * * * *', jobType: ' ', payload: null }))
            .toThrow('jobType must not be empty');
    });
});
