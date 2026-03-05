import { CommandDefinition, ICommandOutput, ILogger } from '../../interfaces.js';
import { IQueue, Job } from '../interfaces.js';

const validStatuses: Array<Job['status']> = ['pending', 'processing', 'failed', 'completed'];

function normalizeStatus(status: string): Job['status'] | null {
    const normalized = status.trim().toLowerCase();
    return (validStatuses as string[]).includes(normalized) ? (normalized as Job['status']) : null;
}

function parseLimit(value: any, fallback: number): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (Number.isNaN(parsed) || parsed <= 0) return fallback;
    return parsed;
}

export function queueCommands(): CommandDefinition[] {
    return [
        {
            name: 'list',
            description: 'List jobs by status (pending|processing|failed|completed)',
            args: '[status]',
            options: [
                { flags: '--limit <number>', description: 'Max jobs to return', default: 20 },
                { flags: '--type <type>', description: 'Filter by job type' }
            ],
            action: async (args, app, output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;
                // Safely check for LoggerOptions (might not be bound for direct container usage)
                const options = app.bound('LoggerOptions') ? app.make('LoggerOptions') : {};
                const isJson = options.mode === 'json';

                const status = normalizeStatus(args.status ?? 'failed');

                if (!status) {
                    logger.error('Invalid status', {
                        status: args.status,
                        valid: validStatuses.join(', '),
                        example: 'gears queue list failed'
                    });
                    return;
                }

                const limit = parseLimit(args.limit, 20);
                const type = args.type;

                const jobs = await queue.list(status, limit, type);

                if (isJson) {
                    output?.log(JSON.stringify(jobs, null, 2));
                    return;
                }

                if (jobs.length === 0) {
                    output?.log(`No ${status} jobs found${type ? ` of type '${type}'` : ''}.`);
                    return;
                }

                output?.log(`Found ${jobs.length} ${status} jobs:`);
                for (const job of jobs) {
                    output?.log(`- [${job.id}] ${job.type}`);
                    output?.log(`    Attempts: ${job.attempts}, Updated: ${job.updated_at ? new Date(job.updated_at).toISOString() : 'N/A'}`);
                    if (job.error) {
                        output?.log(`    Error: ${job.error}`);
                    }
                }
            }
        },
        {
            name: 'inspect',
            description: 'Inspect a job by id',
            args: '<id>',
            action: async (args, app, output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;
                const options = app.bound('LoggerOptions') ? app.make('LoggerOptions') : {};
                const isJson = options.mode === 'json';

                const job = await queue.get(args.id);

                if (!job) {
                    if (isJson) {
                        output?.log('null');
                    } else {
                        logger.warn('Job not found', { id: args.id, hint: 'Try: gears queue list failed' });
                    }
                    return;
                }

                if (isJson) {
                    output?.log(JSON.stringify(job, null, 2));
                } else {
                    output?.log(`Job ${job.id}:`);
                    output?.log(JSON.stringify(job, null, 2));
                }
            }
        },
        {
            name: 'retry',
            description: 'Retry a failed job by id',
            args: '<id>',
            action: async (args, app, _output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;
                const ok = await queue.retryFailed(args.id);

                if (!ok) {
                    logger.warn('Job not retried (not found or not failed)', {
                        id: args.id,
                        hint: 'Use gears queue inspect <id> to check status'
                    });
                    return;
                }

                logger.info('Job retried', { id: args.id });
            }
        },
        {
            name: 'retry-all',
            description: 'Retry all failed jobs',
            options: [
                { flags: '--type <type>', description: 'Filter by job type' }
            ],
            action: async (args, app, _output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;
                const count = await queue.retryAll(args.type);
                logger.info('Retried failed jobs', { count, type: args.type });
                if (count === 0) {
                    logger.warn('No failed jobs retried', { hint: 'Try: gears queue list failed' });
                }
            }
        },
        {
            name: 'clear',
            description: 'Clear jobs by status',
            args: '<status>',
            options: [
                { flags: '--type <type>', description: 'Filter by job type' }
            ],
            action: async (args, app, _output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;
                const status = normalizeStatus(args.status);

                if (!status) {
                    logger.error('Invalid status', {
                        status: args.status,
                        valid: validStatuses.join(', '),
                        example: 'gears queue clear failed'
                    });
                    return;
                }

                const count = await queue.clear(status, args.type);
                logger.info('Cleared jobs', { count, status, type: args.type });
            }
        },
        {
            name: 'stats',
            description: 'Show queue statistics',
            action: async (_args, app, output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;
                const options = app.bound('LoggerOptions') ? app.make('LoggerOptions') : {};
                const isJson = options.mode === 'json';

                try {
                    const stats = await queue.stats();
                    if (isJson) {
                        output?.log(JSON.stringify(stats, null, 2));
                    } else {
                        output?.log('Queue Statistics:');
                        output?.log(JSON.stringify(stats, null, 2));
                    }
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    logger.error('Failed to get stats', { error: message });
                }
            }
        },
        {
            name: 'delete',
            description: 'Delete a job by id',
            args: '<id>',
            action: async (args, app, _output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;
                const ok = await queue.delete(args.id);

                if (!ok) {
                    logger.warn('Job not found', { id: args.id, hint: 'Try: gears queue list failed' });
                    return;
                }

                logger.info('Job deleted', { id: args.id });
            }
        },
        {
            name: 'requeue',
            description: 'Move a stuck processing job back to pending',
            args: '<id>',
            action: async (args, app, _output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;

                const job = await queue.get(args.id);
                if (!job) {
                    logger.warn('Job not found', { id: args.id });
                    return;
                }
                if (job.status !== 'processing') {
                    logger.warn('Job is not in processing state', { id: args.id, status: job.status, hint: 'Only processing jobs can be requeued' });
                    return;
                }

                await queue.release(args.id);
                logger.info('Job requeued', { id: args.id, type: job.type });
            }
        },
        {
            name: 'requeue-all',
            description: 'Move all stuck processing jobs back to pending',
            options: [
                { flags: '--type <type>', description: 'Filter by job type' }
            ],
            action: async (args, app, _output?: ICommandOutput) => {
                const logger = app.make('ILogger') as ILogger;
                const queue = app.make('IQueue') as IQueue;
                const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : undefined;

                let count = 0;
                if (!type) {
                    // Requeue all processing jobs regardless of age.
                    count = await queue.recover(0);
                } else {
                    // IQueue has no bulk "requeue by type", so we filter processing jobs then release each one.
                    const jobs = await queue.list('processing', Number.MAX_SAFE_INTEGER, type);
                    for (const job of jobs) {
                        await queue.release(job.id);
                    }
                    count = jobs.length;
                }

                logger.info('Requeued processing jobs', { count, type });
                if (count === 0) {
                    logger.warn('No processing jobs found', { type });
                }
            }
        }
    ];
}
