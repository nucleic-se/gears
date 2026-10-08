import cron from 'node-cron';
import { CronExpressionParser } from 'cron-parser';

/** A calendar schedule, independent of any worker, queue or registration. */
export type CronSchedule = Readonly<{ cron: string; timeZone: string }>;

function fields(schedule: CronSchedule): string[] {
    if (typeof schedule.cron !== 'string' || typeof schedule.timeZone !== 'string' || !schedule.timeZone.trim()) {
        throw new TypeError('A cron expression and explicit timezone are required');
    }
    new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone });
    const parts = schedule.cron.trim().split(/\s+/);
    if ((parts.length !== 5 && parts.length !== 6) || !cron.validate(schedule.cron)) {
        throw new TypeError('Expected a valid five-field cron expression or six fields including seconds');
    }
    return parts;
}

/** Throws for invalid syntax, timezone or impossible explicit calendar dates. */
export function validateCronSchedule(schedule: CronSchedule): void {
    fields(schedule);
    // A fixed reference keeps validation independent of the caller's wall clock.
    CronExpressionParser.parse(schedule.cron, { tz: schedule.timeZone, currentDate: new Date('2000-01-01T00:00:00Z') });
}

/**
 * Calculate strictly after `after`, without registering work or using the wall clock.
 * Calendar iteration uses cron-parser's DST policy; runtime delivery remains the
 * responsibility of the caller. Both day-of-month and weekday must match, as in Gears.
 */
export function nextCronOccurrence(schedule: CronSchedule, after: Date): Date {
    if (!(after instanceof Date) || !Number.isFinite(after.getTime())) throw new TypeError('after must be a valid Date');
    const parts = fields(schedule);
    const options = { tz: schedule.timeZone, currentDate: after };
    const parsed = CronExpressionParser.parse(schedule.cron, options);
    const weekdays = parsed.fields.dayOfWeek.values;
    // The parser normally uses OR for the two day fields. Iterate the month/day
    // calendar and filter weekdays to preserve the scheduler's AND contract.
    parts[parts.length - 1] = '*';
    const calendar = parts.join(' ');
    let cursor = after;
    const horizon = after.getUTCFullYear() + 400;
    while (cursor.getUTCFullYear() <= horizon) {
        const candidate = CronExpressionParser.parse(calendar, { ...options, currentDate: cursor }).next();
        if (candidate.getUTCFullYear() > horizon) break;
        if (weekdays.some((day) => day === candidate.getDay())) return candidate.toDate();
        // Skip a whole nonmatching local day, not every second/minute within it.
        candidate.setEndOfDay();
        cursor = candidate.toDate();
    }
    throw new RangeError('No matching cron occurrence within 400 years');
}
