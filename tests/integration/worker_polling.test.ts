import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from '../../src/core/queue/Worker.js';
import { Container } from '../../src/core/container/Container.js';
import type { IQueue, Job } from '../../src/core/queue/interfaces.js';

describe('worker polling lifecycle', () => {
    let worker: Worker | undefined;
    afterEach(async () => { await worker?.stop(); vi.useRealTimers(); });

    function setup(pop: () => Promise<Job | null>, handler = async () => {}) {
        const app = new Container();
        app.bind('ILogger', () => ({ info() {}, debug() {}, warn() {}, error() {} }));
        app.bind('JobHandlers', () => new Map([['test', handler]]));
        const queue = { pop, complete: async () => {}, release: async () => {},
            recover: async () => 0, heartbeat: async () => {} } as unknown as IQueue;
        worker = new Worker(queue, app, { maxConcurrency: 5, pollInterval: 50 });
        return worker;
    }

    const job = (id: string): Job => ({ id, type: 'test', payload: {}, attempts: 0,
        status: 'processing', created_at: 0, priority: 0 });

    it('returns to one idle poll cadence after 100 completed jobs', async () => {
        vi.useFakeTimers();
        let remaining = 100;
        const pop = vi.fn(async () => remaining-- > 0 ? ({ id: String(remaining),
            type: 'test', payload: {}, attempts: 0, status: 'processing',
            created_at: 0, priority: 0 } as Job) : null);
        setup(pop).start();
        await vi.advanceTimersByTimeAsync(100);
        expect(remaining).toBeLessThanOrEqual(0);
        const before = pop.mock.calls.length;
        await vi.advanceTimersByTimeAsync(750);
        expect(pop.mock.calls.length - before).toBeLessThanOrEqual(16);
    });

    it('serializes asynchronous pops and waits for an outstanding pop on stop', async () => {
        vi.useFakeTimers();
        let release!: (job: Job | null) => void;
        const pop = vi.fn(() => new Promise<Job | null>(resolve => { release = resolve; }));
        const instance = setup(pop);
        instance.start();
        await vi.advanceTimersByTimeAsync(0);
        let stopped = false;
        const stopping = instance.stop().then(() => { stopped = true; });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release(null);
        await stopping;
        const calls = pop.mock.calls.length;
        await vi.advanceTimersByTimeAsync(500);
        expect(pop.mock.calls.length).toBe(calls);
    });

    it('releases a claim arriving during shutdown and permits restart only after stop settles', async () => {
        vi.useFakeTimers();
        let resolvePop!: (value: Job | null) => void;
        const pop = vi.fn(() => new Promise<Job | null>(resolve => { resolvePop = resolve; }));
        const handler = vi.fn(async () => {});
        const instance = setup(pop, handler);
        const release = vi.fn(async () => {});
        (instance as any).queue.release = release;
        instance.start(); instance.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(pop).toHaveBeenCalledTimes(1);
        const stopping = instance.stop();
        expect(instance.stop()).toBe(stopping);
        expect(() => instance.start()).toThrow('still stopping');
        resolvePop(job('late'));
        await stopping;
        expect(release).toHaveBeenCalledWith('late', undefined);
        expect(handler).not.toHaveBeenCalled();
        instance.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(pop).toHaveBeenCalledTimes(2);
        const stopped = instance.stop(); resolvePop(null); await stopped;
        await vi.advanceTimersByTimeAsync(500);
        expect(pop).toHaveBeenCalledTimes(2);
    });

    it('coalesces completions during an asynchronous pop without exceeding concurrency', async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        let resolvePop!: (value: Job | null) => void;
        let inFlight = 0, peak = 0, handlers = 0, peakHandlers = 0;
        const pop = vi.fn(async () => {
            peak = Math.max(peak, ++inFlight);
            try {
                if (pop.mock.calls.length === 1) return job('first');
                return await new Promise<Job | null>(resolve => { resolvePop = resolve; });
            } finally { inFlight--; }
        });
        const instance = setup(pop, async () => {
            peakHandlers = Math.max(peakHandlers, ++handlers);
            await new Promise<void>(resolve => { finish = resolve; });
            handlers--;
        });
        instance.start();
        await vi.advanceTimersByTimeAsync(0);
        finish();
        await vi.advanceTimersByTimeAsync(100);
        expect(pop).toHaveBeenCalledTimes(2);
        expect(peak).toBe(1);
        resolvePop(null);
        await vi.advanceTimersByTimeAsync(1);
        expect(pop).toHaveBeenCalledTimes(3);
        expect(peakHandlers).toBeLessThanOrEqual(5);
        const stopping = instance.stop(); resolvePop(null); await stopping;
    });

    it('preserves error backoff when an active job finishes', async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        const pop = vi.fn(async () => {
            if (pop.mock.calls.length === 1) return job('first');
            if (pop.mock.calls.length === 2) throw new Error('queue unavailable');
            return null;
        });
        setup(pop, async () => { await new Promise<void>(resolve => { finish = resolve; }); }).start();
        await vi.advanceTimersByTimeAsync(0);
        finish();
        await vi.advanceTimersByTimeAsync(4999);
        expect(pop).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(pop).toHaveBeenCalledTimes(3);
    });

    it('fills exactly five slots and claims the next job only after a slot settles', async () => {
        vi.useFakeTimers();
        const finishes: Array<() => void> = [];
        let pendingPop!: (value: Job | null) => void;
        const pop = vi.fn(async () => pop.mock.calls.length <= 5 ? job(String(pop.mock.calls.length))
            : await new Promise<Job | null>(resolve => { pendingPop = resolve; }));
        let active = 0, peak = 0;
        const instance = setup(pop, async () => {
            peak = Math.max(peak, ++active);
            await new Promise<void>(resolve => { finishes.push(resolve); });
            active--;
        });
        instance.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(pop).toHaveBeenCalledTimes(5);
        expect(active).toBe(5);
        finishes.shift()!();
        await vi.advanceTimersByTimeAsync(1);
        expect(pop).toHaveBeenCalledTimes(6);
        finishes.shift()!(); finishes.shift()!();
        await vi.advanceTimersByTimeAsync(100);
        expect(pop).toHaveBeenCalledTimes(6);
        expect(peak).toBe(5);
        const stopping = instance.stop();
        pendingPop(null);
        finishes.forEach(finish => finish());
        await stopping;
    });
});
