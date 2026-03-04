
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../src/core/events/EventBus.js';
import { Container } from '../../src/core/container/Container.js';
import { MemoryLogger } from '../../src/test/mocks/MemoryLogger.js';

describe('EventBus', () => {
    let app: Container;
    let bus: EventBus;
    let logger: MemoryLogger;

    beforeEach(() => {
        app = new Container();
        logger = new MemoryLogger();
        app.singleton('ILogger', () => logger);
        bus = new EventBus(app);
    });

    it('should register and call a listener', async () => {
        const handler = vi.fn();
        bus.on('test-event', handler);
        await bus.emit('test-event', { foo: 'bar' });
        expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
    });

    it('should wait for async listeners', async () => {
        let finished = false;
        const handler = async () => {
            await new Promise(r => setTimeout(r, 10));
            finished = true;
        };
        bus.on('async-event', handler);
        await bus.emit('async-event', {});
        expect(finished).toBe(true);
    });

    it('should handle multiple listeners in parallel', async () => {
        const order: number[] = [];
        const h1 = async () => {
            await new Promise(r => setTimeout(r, 20)); // Slow
            order.push(1);
        };
        const h2 = async () => {
            await new Promise(r => setTimeout(r, 5)); // Fast
            order.push(2);
        };

        bus.on('parallel', h1);
        bus.on('parallel', h2);

        await bus.emit('parallel', {});

        // h2 should finish first if parallel, but emit waits for both
        expect(order).toContain(1);
        expect(order).toContain(2);
        expect(order.length).toBe(2);
    });

    it('emit() should not throw on listener error', async () => {
        const h1 = () => { throw new Error('Fail'); };
        const h2 = vi.fn();

        bus.on('error-test', h1);
        bus.on('error-test', h2);

        await expect(bus.emit('error-test', {})).resolves.not.toThrow();
        expect(h2).toHaveBeenCalled(); // Other listeners should still run/finish

        // Should log error
        expect(logger.logs.some(l => l.level === 'error' && l.message === 'Event listener failed')).toBe(true);
    });

    it('emitStrict() should throw on listener error', async () => {
        const h1 = async () => { throw new Error('Strict Fail'); };
        bus.on('strict-test', h1);

        await expect(bus.emitStrict('strict-test', {})).rejects.toThrow('Strict Fail');
    });

    it('emitStrict() should run all listeners even if one throws synchronously', async () => {
        const h1 = () => { throw new Error('Sync Fail'); };
        const h2 = vi.fn();

        bus.on('strict-sync-test', h1);
        bus.on('strict-sync-test', h2);

        // Should reject because h1 fails
        await expect(bus.emitStrict('strict-sync-test', {})).rejects.toThrow('Sync Fail');

        // BUT h2 should have been called because h1's failure is captured as a rejection 
        // parallel to h2 execution start.
        expect(h2).toHaveBeenCalled();
    });

    it('off() should remove listener', async () => {
        const handler = vi.fn();
        bus.on('remove-test', handler);
        bus.off('remove-test', handler);
        await bus.emit('remove-test', {});
        expect(handler).not.toHaveBeenCalled();
    });

    it('should support duplicate listeners and remove them one by one', async () => {
        const handler = vi.fn();

        bus.on('dup-test', handler);
        bus.on('dup-test', handler);

        // Both should run
        await bus.emit('dup-test', {});
        expect(handler).toHaveBeenCalledTimes(2);

        handler.mockClear();

        // Remove one
        bus.off('dup-test', handler);

        // Check only one remains
        await bus.emit('dup-test', {});
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('clear() should remove all listeners', async () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.on('clear-test', h1);
        bus.on('clear-test', h2);
        bus.clear('clear-test');

        await bus.emit('clear-test', {});
        expect(h1).not.toHaveBeenCalled();
        expect(h2).not.toHaveBeenCalled();
    });
});
