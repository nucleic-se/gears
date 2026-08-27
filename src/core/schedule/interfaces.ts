import type { JobOptions } from '../queue/interfaces.js';

export type ScheduledOccurrence = {
    scheduleId: string;
    scheduledFor: string;
    occurrenceId: string;
};

export type ScheduledJobEnvelope<T> = {
    occurrence: ScheduledOccurrence;
    payload: T;
};

export type ScheduledJobDefinition<T> = {
    /** Stable application-owned identity for the schedule. */
    id: string;
    cron: string;
    jobType: string;
    payload: T;
    jobOptions?: JobOptions;
    lockTtlMs?: number;
};

export interface IScheduledJobRegistrar {
    register<T>(definition: ScheduledJobDefinition<T>): void;
    unregister(scheduleId: string): void;
    list(): ScheduledJobDefinition<unknown>[];
}
