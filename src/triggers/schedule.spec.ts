import { describe, expect, it } from 'vitest';
import { nextOccurrence, type Schedule } from './schedule.js';

/** The next `count` occurrences of `cron` in `timezone` after `from`. */
function occurrences(
  cron: string,
  timezone: string,
  from: string,
  count: number,
): string[] {
  const found: string[] = [];
  let after = new Date(from);
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence({ cron, timezone }, after);
    if (next === null) break;
    found.push(next.toISOString());
    after = next;
  }
  return found;
}

describe('nextOccurrence', () => {
  describe('outside daylight-saving changes', () => {
    it('matches local time in the zone', () => {
      expect(
        occurrences('0 9 * * *', 'Europe/Berlin', '2026-09-28T12:00:00Z', 2),
      ).toEqual(['2026-09-29T07:00:00.000Z', '2026-09-30T07:00:00.000Z']);
      expect(
        occurrences('0 9 * * *', 'UTC', '2026-09-28T12:00:00Z', 1),
      ).toEqual(['2026-09-29T09:00:00.000Z']);
    });

    it('handles offsets that are not whole hours', () => {
      expect(
        occurrences('0 0 * * *', 'Asia/Kathmandu', '2026-01-01T00:00:00Z', 2),
      ).toEqual(['2026-01-01T18:15:00.000Z', '2026-01-02T18:15:00.000Z']);
    });

    it('returns a time strictly after the one given', () => {
      const schedule: Schedule = { cron: '0 9 * * *', timezone: 'UTC' };
      expect(
        nextOccurrence(
          schedule,
          new Date('2026-01-01T09:00:00Z'),
        )?.toISOString(),
      ).toBe('2026-01-02T09:00:00.000Z');
      expect(
        nextOccurrence(
          schedule,
          new Date('2026-01-01T09:00:00.005Z'),
        )?.toISOString(),
      ).toBe('2026-01-02T09:00:00.000Z');
      expect(
        nextOccurrence(
          schedule,
          new Date('2026-01-01T08:59:59.999Z'),
        )?.toISOString(),
      ).toBe('2026-01-01T09:00:00.000Z');
    });

    it('accepts nicknames', () => {
      expect(
        occurrences('@hourly', 'Europe/Berlin', '2026-09-28T12:10:00Z', 2),
      ).toEqual(['2026-09-28T13:00:00.000Z', '2026-09-28T14:00:00.000Z']);
      // Midnight between Saturday and Sunday.
      expect(
        occurrences('@weekly', 'Europe/Berlin', '2026-09-28T12:00:00Z', 1),
      ).toEqual(['2026-10-03T22:00:00.000Z']);
    });

    it('returns null for a schedule no date matches', () => {
      expect(
        nextOccurrence(
          { cron: '0 9 30 2 *', timezone: 'UTC' },
          new Date('2026-01-01T00:00:00Z'),
        ),
      ).toBeNull();
    });
  });

  describe('when the clocks go forward', () => {
    it('runs a skipped time the moment the clocks jump', () => {
      // Europe/Berlin jumps from 02:00 to 03:00 on 2026-03-29.
      expect(
        occurrences('30 2 * * *', 'Europe/Berlin', '2026-03-28T12:00:00Z', 2),
      ).toEqual([
        '2026-03-29T01:00:00.000Z', // 03:00 CEST
        '2026-03-30T00:30:00.000Z',
      ]);
      // America/New_York jumps from 02:00 to 03:00 on 2026-03-08.
      expect(
        occurrences(
          '30 2 * * *',
          'America/New_York',
          '2026-03-07T12:00:00Z',
          2,
        ),
      ).toEqual([
        '2026-03-08T07:00:00.000Z', // 03:00 EDT
        '2026-03-09T06:30:00.000Z',
      ]);
    });

    it('handles a half-hour jump', () => {
      // Australia/Lord_Howe jumps from 02:00 to 02:30 on 2026-10-04.
      expect(
        occurrences(
          '15 2 * * *',
          'Australia/Lord_Howe',
          '2026-10-03T00:00:00Z',
          2,
        ),
      ).toEqual([
        '2026-10-03T15:30:00.000Z', // 02:30 +11:00
        '2026-10-04T15:15:00.000Z',
      ]);
    });

    it('handles a jump at midnight', () => {
      // America/Santiago jumps from 00:00 to 01:00 on 2026-09-06.
      expect(
        occurrences('0 0 * * *', 'America/Santiago', '2026-09-04T12:00:00Z', 3),
      ).toEqual([
        '2026-09-05T04:00:00.000Z',
        '2026-09-06T04:00:00.000Z', // 01:00 -03:00
        '2026-09-07T03:00:00.000Z',
      ]);
    });

    it('finds the jump from earlier the same night', () => {
      expect(
        nextOccurrence(
          { cron: '30 2 * * *', timezone: 'Europe/Berlin' },
          new Date('2026-03-29T00:59:30Z'),
        )?.toISOString(),
      ).toBe('2026-03-29T01:00:00.000Z');
    });

    it('makes one run of times that land on the same instant', () => {
      expect(
        occurrences('0 2,3 * * *', 'Europe/Berlin', '2026-03-28T12:00:00Z', 2),
      ).toEqual(['2026-03-29T01:00:00.000Z', '2026-03-30T00:00:00.000Z']);
      expect(
        occurrences('*/15 * * * *', 'Europe/Berlin', '2026-03-29T00:40:00Z', 4),
      ).toEqual([
        '2026-03-29T00:45:00.000Z', // 01:45 CET
        '2026-03-29T01:00:00.000Z', // 02:00–02:45 and 03:00 CEST
        '2026-03-29T01:15:00.000Z',
        '2026-03-29T01:30:00.000Z',
      ]);
      expect(
        occurrences('30 * * * *', 'Europe/Berlin', '2026-03-29T00:00:00Z', 4),
      ).toEqual([
        '2026-03-29T00:30:00.000Z', // 01:30 CET
        '2026-03-29T01:00:00.000Z', // 02:30, skipped
        '2026-03-29T01:30:00.000Z', // 03:30 CEST
        '2026-03-29T02:30:00.000Z',
      ]);
    });
  });

  describe('when the clocks go back', () => {
    it('runs a repeated time once, at its first occurrence', () => {
      // Europe/Berlin repeats 02:00–03:00 on 2026-10-25: first CEST, then CET.
      expect(
        occurrences('30 2 * * *', 'Europe/Berlin', '2026-10-24T12:00:00Z', 2),
      ).toEqual([
        '2026-10-25T00:30:00.000Z', // 02:30 CEST
        '2026-10-26T01:30:00.000Z',
      ]);
    });

    it('skips the second pass from anywhere in the repeated hour', () => {
      const schedule: Schedule = {
        cron: '30 2 * * *',
        timezone: 'Europe/Berlin',
      };
      for (const after of [
        '2026-10-25T00:31:00Z',
        '2026-10-25T01:15:00Z',
        '2026-10-25T01:30:00Z',
      ]) {
        expect(nextOccurrence(schedule, new Date(after))?.toISOString()).toBe(
          '2026-10-26T01:30:00.000Z',
        );
      }
    });

    it('does not run while the hour repeats', () => {
      expect(
        occurrences('*/20 * * * *', 'Europe/Berlin', '2026-10-25T00:10:00Z', 4),
      ).toEqual([
        '2026-10-25T00:20:00.000Z', // 02:20 CEST
        '2026-10-25T00:40:00.000Z', // 02:40 CEST
        '2026-10-25T02:00:00.000Z', // 03:00 CET
        '2026-10-25T02:20:00.000Z',
      ]);
    });

    it('handles the southern hemisphere', () => {
      // Australia/Sydney repeats 02:00–03:00 on 2026-04-05.
      expect(
        occurrences(
          '30 2 * * *',
          'Australia/Sydney',
          '2026-04-04T12:00:00Z',
          2,
        ),
      ).toEqual([
        '2026-04-04T15:30:00.000Z', // 02:30 +11:00
        '2026-04-05T16:30:00.000Z', // 02:30 +10:00
      ]);
    });
  });

  describe('across month and year boundaries', () => {
    it('skips months without the day', () => {
      expect(
        occurrences('0 9 31 * *', 'UTC', '2026-01-01T00:00:00Z', 3),
      ).toEqual([
        '2026-01-31T09:00:00.000Z',
        '2026-03-31T09:00:00.000Z',
        '2026-05-31T09:00:00.000Z',
      ]);
    });

    it('waits for a leap year', () => {
      expect(
        occurrences('0 9 29 2 *', 'Europe/Berlin', '2026-01-01T00:00:00Z', 2),
      ).toEqual(['2028-02-29T08:00:00.000Z', '2032-02-29T08:00:00.000Z']);
    });

    it('finds the last day of each month', () => {
      expect(
        occurrences('0 0 L * *', 'UTC', '2026-01-15T00:00:00Z', 3),
      ).toEqual([
        '2026-01-31T00:00:00.000Z',
        '2026-02-28T00:00:00.000Z',
        '2026-03-31T00:00:00.000Z',
      ]);
    });

    it('starts a new year in the zone, not in UTC', () => {
      expect(
        occurrences('@yearly', 'Asia/Tokyo', '2026-12-31T14:59:00Z', 2),
      ).toEqual(['2026-12-31T15:00:00.000Z', '2027-12-31T15:00:00.000Z']);
      expect(
        occurrences('0 0 1 * *', 'Pacific/Auckland', '2026-12-15T00:00:00Z', 2),
      ).toEqual([
        '2026-12-31T11:00:00.000Z', // 2027-01-01 00:00 +13:00
        '2027-01-31T11:00:00.000Z',
      ]);
      expect(
        occurrences(
          '0 9 * * *',
          'Pacific/Kiritimati',
          '2026-12-30T18:00:00Z',
          2,
        ),
      ).toEqual([
        '2026-12-30T19:00:00.000Z', // 2026-12-31 09:00 +14:00
        '2026-12-31T19:00:00.000Z', // 2027-01-01 09:00 +14:00
      ]);
    });
  });

  it('agrees with itself from any time between two occurrences', () => {
    // Each schedule over a stretch that includes daylight-saving changes.
    const cases: [Schedule, string, string][] = [
      [
        { cron: '30 2 * * *', timezone: 'Europe/Berlin' },
        '2026-03-01T00:00:00Z',
        '2026-11-01T00:00:00Z',
      ],
      [
        { cron: '*/20 * * * *', timezone: 'America/New_York' },
        '2026-11-01T03:00:00Z',
        '2026-11-01T09:00:00Z',
      ],
      [
        { cron: '*/20 * * * *', timezone: 'America/New_York' },
        '2026-03-08T04:00:00Z',
        '2026-03-08T10:00:00Z',
      ],
      [
        { cron: '0 0 * * *', timezone: 'America/Santiago' },
        '2026-03-20T00:00:00Z',
        '2026-09-20T00:00:00Z',
      ],
      [
        { cron: '15 2 * * 0', timezone: 'Australia/Lord_Howe' },
        '2026-01-01T00:00:00Z',
        '2027-01-01T00:00:00Z',
      ],
      [
        { cron: '0 9 1 * *', timezone: 'Asia/Kathmandu' },
        '2026-01-01T00:00:00Z',
        '2027-01-01T00:00:00Z',
      ],
    ];
    for (const [schedule, from, to] of cases) {
      let previous = new Date(from);
      while (previous.getTime() < new Date(to).getTime()) {
        const next = nextOccurrence(schedule, previous)!;
        expect(next.getTime()).toBeGreaterThan(previous.getTime());
        const gap = next.getTime() - previous.getTime();
        for (const fraction of [0.5, 0.999]) {
          const between = new Date(
            previous.getTime() + Math.floor(gap * fraction),
          );
          expect(nextOccurrence(schedule, between)).toEqual(next);
        }
        previous = next;
      }
    }
  });
});
