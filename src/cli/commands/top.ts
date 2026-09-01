import blessed from 'blessed';
import { Container } from '../../core/container/Container.js';
import { IMetrics, MetricSnapshot } from '../../core/metrics/interfaces.js';
import { IQueue } from '../../core/queue/interfaces.js';
import path from 'path';
import fs from 'fs';

export function createTopWidgets(screen: blessed.Widgets.Screen) {
    const statusBox = blessed.box({
        parent: screen,
        top: 0,
        left: 0,
        width: '100%',
        height: 3,
        label: 'System Status',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        padding: { left: 1, right: 1 },
    });

    const queueTable = blessed.listtable({
        parent: screen,
        top: 3,
        left: 0,
        width: '50%',
        height: '42%',
        keys: true,
        label: 'Queue Stats',
        border: { type: 'line' },
        style: {
            border: { fg: 'cyan' },
            header: { fg: 'cyan', bold: true },
            cell: { fg: 'white' },
        },
        tags: false,
    });

    const metricsTable = blessed.listtable({
        parent: screen,
        top: 3,
        left: '50%',
        width: '50%',
        height: '42%',
        keys: true,
        label: 'Key Metrics',
        border: { type: 'line' },
        style: {
            border: { fg: 'green' },
            header: { fg: 'green', bold: true },
            cell: { fg: 'green' },
        },
        tags: false,
    });

    const logBox = blessed.log({
        parent: screen,
        top: '45%',
        left: 0,
        width: '100%',
        height: '55%',
        fg: 'green',
        label: 'Recent Events',
        border: { type: 'line' },
        style: { border: { fg: 'green' } },
        scrollable: true,
    });

    return { statusBox, queueTable, metricsTable, logBox };
}

export async function topCommand(app: Container) {
    const metrics = app.makeOrNull('IMetrics');
    const queue = app.make('IQueue');

    if (!metrics) {
        console.error('Metrics service not available. Ensure IMetrics is registered.');
        process.exit(1);
    }

    const screen = blessed.screen({
        smartCSR: true,
        title: 'Gears Inspector'
    });

    const { statusBox, queueTable, metricsTable, logBox } = createTopWidgets(screen);

    let refreshTimer: NodeJS.Timeout | null = null;
    let shuttingDown = false;
    let resolveExit: (() => void) | null = null;
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });

    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        // Save stdout.write before blessed teardown can clobber it
        const stdoutWrite = process.stdout.write.bind(process.stdout);
        try {
            const program = (screen as any).program;
            if (program) {
                program.disableMouse?.();
                program.showCursor?.();
                program.normalBuffer?.();
                // Mute program output before destroy to prevent tput source dump,
                // but do NOT mute process.stdout itself (we need it below).
                const noop = () => true;
                program.write = noop;
                program._write = noop;
            }
            screen.destroy();
        } catch {
            // Blessed can throw during teardown — ignore
        }
        // Reset terminal manually using the saved write reference
        stdoutWrite('\x1b[?1049l\x1b[?25h\x1b[0m\n');
        try {
            await app.shutdown();
        } catch {
            // Ignore shutdown errors
        }
        resolveExit?.();
    };

    screen.key(['escape', 'q', 'C-c'], () => { void shutdown(); });
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });

    // Refresh Loop
    let lastLogTime = Date.now();

    const refresh = async () => {
        try {
            // Update Status
            const uptime = process.uptime().toFixed(0);
            statusBox.setContent(`Gears Inspector | Uptime: ${uptime}s | Queue: durable`);

            // Update Queue Stats
            const qStats = await queue.stats();
            const qData = [
                ['Pending', String(qStats.overview.pending || 0)],
                ['Processing', String(qStats.overview.processing || 0)],
                ['Failed', String(qStats.overview.failed || 0)],
                ['Completed', String(qStats.overview.completed || 0)]
            ];
            queueTable.setData([
                ['Status', 'Count', 'Trend'],
                ...qData.map(r => [...r, '-']),
            ]);

            // Update Metrics
            const snapshot = await metrics.snapshot();
            const relevantMetrics = snapshot
                .filter(m => !m.name.startsWith('queue.depth')) // Queue depth shown in table
                .slice(0, 10); // Limit to top 10 for now

            const mData = relevantMetrics.map(m => [
                m.name,
                String(m.value),
                m.tags.type || '-'
            ]);
            metricsTable.setData([
                ['Metric', 'Value', 'Type'],
                ...mData,
            ]);

            // Tail log lines from file
            try {
                const logPath = path.join(app.make('DataPaths').dataDir, 'app.log');
                if (fs.existsSync(logPath)) {
                    // Read last 4KB
                    const stats = fs.statSync(logPath);
                    const size = stats.size;
                    const readSize = Math.min(size, 4096);
                    const buffer = Buffer.alloc(readSize);

                    const fd = fs.openSync(logPath, 'r');
                    fs.readSync(fd, buffer, 0, readSize, size - readSize);
                    fs.closeSync(fd);

                    const text = buffer.toString('utf-8');
                    const lines = text.split('\n').filter(Boolean);

                    // Simple Polling Tail:
                    const lastLines = lines.slice(-20); // Check last 20
                    lastLines.forEach(line => {
                        try {
                            const json = JSON.parse(line);
                            if (json.msg && json.time && json.time > lastLogTime) {
                                logBox.log(`${new Date(json.time).toLocaleTimeString()} ${json.msg}`);
                                lastLogTime = json.time;
                            }
                        } catch (e) {
                            // non-json line?
                        }
                    });
                }
            } catch (e) {
                // ignore log read errors
            }

            screen.render();
        } catch (e) {
            logBox.log(`Error updating: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    refreshTimer = setInterval(refresh, 1000);
    refresh(); // Initial

    await exitPromise;
}
