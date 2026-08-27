import type { IScheduler } from '../interfaces.js';
import type { IQueue } from '../queue/interfaces.js';
import type {
    IScheduledJobRegistrar,
    ScheduledJobDefinition,
    ScheduledJobEnvelope,
    ScheduledOccurrence,
} from './interfaces.js';

/** Connects cron triggers to the durable queue without executing domain work. */
export class ScheduledJobRegistrar implements IScheduledJobRegistrar {
    private readonly definitions = new Map<string, ScheduledJobDefinition<unknown>>();

    constructor(
        private readonly scheduler: IScheduler,
        private readonly queue: IQueue,
        private readonly now: () => Date = () => new Date(),
    ) {}

    register<T>(definition: ScheduledJobDefinition<T>): void {
        const normalized = this.validate(definition);
        if (this.definitions.has(normalized.id)) {
            throw new Error(`Scheduled job already registered: ${normalized.id}`);
        }

        this.definitions.set(normalized.id, normalized as ScheduledJobDefinition<unknown>);
        this.scheduler.schedule(
            normalized.cron,
            async () => {
                const scheduledFor = this.now();
                scheduledFor.setMilliseconds(0);
                const occurrence: ScheduledOccurrence = {
                    scheduleId: normalized.id,
                    scheduledFor: scheduledFor.toISOString(),
                    occurrenceId: `${normalized.id}:${scheduledFor.toISOString()}`,
                };
                const envelope: ScheduledJobEnvelope<T> = {
                    occurrence,
                    payload: structuredClone(normalized.payload),
                };
                await this.queue.add(normalized.jobType, envelope, normalized.jobOptions);
            },
            normalized.id,
            normalized.lockTtlMs === undefined ? undefined : { lockTtlMs: normalized.lockTtlMs },
        );
    }

    unregister(scheduleId: string): void {
        if (!this.definitions.delete(scheduleId)) return;
        this.scheduler.unschedule(scheduleId);
    }

    list(): ScheduledJobDefinition<unknown>[] {
        return [...this.definitions.values()].map((definition) => structuredClone(definition));
    }

    private validate<T>(definition: ScheduledJobDefinition<T>): ScheduledJobDefinition<T> {
        const id = definition.id.trim();
        const cron = definition.cron.trim();
        const jobType = definition.jobType.trim();
        if (!id) throw new TypeError('Scheduled job id must not be empty');
        if (!cron) throw new TypeError(`Scheduled job ${id}: cron must not be empty`);
        if (!jobType) throw new TypeError(`Scheduled job ${id}: jobType must not be empty`);
        if (definition.payload === undefined) {
            throw new TypeError(`Scheduled job ${id}: payload must not be undefined`);
        }
        return { ...definition, id, cron, jobType };
    }
}
