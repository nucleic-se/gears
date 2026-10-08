import { describe, expect, it } from 'vitest';
import { nextCronOccurrence, validateCronSchedule } from '../../src/core/schedule/CronTiming.js';

const utc = (cron: string) => ({ cron, timeZone: 'UTC' });
const stockholm = { cron: '0 9 * * *', timeZone: 'Europe/Stockholm' };

describe('cron timing', () => {
    it('calculates strictly after an explicit instant without mutating it', () => {
        const after = new Date('2026-10-08T09:00:00.000Z');
        expect(nextCronOccurrence(utc('0 9 * * *'), after).toISOString()).toBe('2026-10-09T09:00:00.000Z');
        expect(after.toISOString()).toBe('2026-10-08T09:00:00.000Z');
        expect(nextCronOccurrence(utc('*/15 * * * * *'), new Date('2026-10-08T09:00:00.001Z')).toISOString())
            .toBe('2026-10-08T09:00:15.000Z');
    });

    it('supports steps, ranges, names, Sunday 7 and leap years', () => {
        expect(nextCronOccurrence(utc('0 9 * * MON-FRI'), new Date('2026-10-09T09:00:00Z')).toISOString()).toBe('2026-10-12T09:00:00.000Z');
        expect(nextCronOccurrence(utc('0 9 * * 7'), new Date('2026-10-09T09:00:00Z')).toISOString()).toBe('2026-10-11T09:00:00.000Z');
        expect(nextCronOccurrence(utc('0 0 29 FEB *'), new Date('2026-01-01T00:00:00Z')).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    });

    it('requires day of month AND weekday like the existing Gears scheduler', () => {
        expect(nextCronOccurrence(utc('0 9 1 * MON'), new Date('2026-10-01T00:00:00Z')).toISOString()).toBe('2027-02-01T09:00:00.000Z');
        expect(nextCronOccurrence(utc('* * 1 * MON'), new Date('2026-10-01T00:00:00Z')).toISOString()).toBe('2027-02-01T00:00:00.000Z');
    });

    it('keeps local 09:00 across both Stockholm DST transitions', () => {
        expect(nextCronOccurrence(stockholm, new Date('2026-03-28T08:00:00Z')).toISOString()).toBe('2026-03-29T07:00:00.000Z');
        expect(nextCronOccurrence(stockholm, new Date('2026-10-24T07:00:00Z')).toISOString()).toBe('2026-10-25T08:00:00.000Z');
    });

    it('defines the parser policy for nonexistent and repeated local times', () => {
        const schedule = { cron: '30 2 * * *', timeZone: 'Europe/Stockholm' };
        expect(nextCronOccurrence(schedule, new Date('2026-03-28T23:00:00Z')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
        const first = nextCronOccurrence(schedule, new Date('2026-10-24T23:00:00Z'));
        expect(first.toISOString()).toBe('2026-10-25T00:30:00.000Z');
        expect(nextCronOccurrence(schedule, first).toISOString()).toBe('2026-10-26T01:30:00.000Z');
    });

    it('rejects invalid inputs rather than guessing a timezone or reading the clock', () => {
        for (const cron of ['', '* *', '60 * * * *', '0 0 31 2 *', '@daily', '0 0 L * *']) {
            expect(() => validateCronSchedule(utc(cron))).toThrow();
        }
        for (const timeZone of ['', 'Mars/Olympus']) {
            expect(() => validateCronSchedule({ cron: '* * * * *', timeZone })).toThrow();
        }
        expect(() => nextCronOccurrence(stockholm, new Date(NaN))).toThrow();
        expect(() => validateCronSchedule(stockholm)).not.toThrow();
    });
});
