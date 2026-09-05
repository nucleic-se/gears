import { beforeEach, describe, expect, it, vi } from 'vitest';

const blessedMocks = vi.hoisted(() => ({
    box: vi.fn(() => ({ kind: 'box' })),
    listtable: vi.fn((_options: { label?: string }) => ({ kind: 'table' })),
    log: vi.fn(() => ({ kind: 'log' })),
}));

vi.mock('blessed', () => ({ default: blessedMocks }));

import { createTopWidgets } from '../../src/cli/commands/top.js';

describe('Gears top dashboard', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('builds the status, queue, metrics, and log widgets without contrib', () => {
        const screen = {} as never;
        const widgets = createTopWidgets(screen);

        expect(blessedMocks.box).toHaveBeenCalledOnce();
        expect(blessedMocks.listtable).toHaveBeenCalledTimes(2);
        expect(blessedMocks.log).toHaveBeenCalledOnce();
        expect(widgets).toEqual({
            statusBox: { kind: 'box' },
            queueTable: { kind: 'table' },
            metricsTable: { kind: 'table' },
            logBox: { kind: 'log' },
        });
        expect(blessedMocks.listtable.mock.calls.map(call => call[0]?.label)).toEqual([
            'Queue Stats', 'Key Metrics',
        ]);
    });
});
