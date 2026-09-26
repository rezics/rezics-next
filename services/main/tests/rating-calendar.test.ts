import { expect, test } from 'bun:test';
import { canonicalRatingTimeZone, dailyRatingSlotIri, ratingDayPeriod,
  retainedRatingPeriod } from '../src/modules/rating/calendar.ts';

test('RATE03: server civil periods resolve DST, repeated hours and skipped midnight', () => {
  const cases = [
    ['America/New_York', '2026-03-08T06:59:59.999Z', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['America/New_York', '2026-03-08T07:00:00.000Z', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['America/New_York', '2026-11-01T05:30:00.000Z', '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['America/New_York', '2026-11-01T06:30:00.000Z', '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['America/New_York', '2026-03-09T04:00:00.000Z', '2026-03-09', '2026-03-09T04:00:00.000Z', '2026-03-10T04:00:00.000Z'],
    ['America/Sao_Paulo', '2018-11-04T04:00:00.000Z', '2018-11-04', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z'],
    ['Pacific/Apia', '2011-12-30T09:00:00.000Z', '2011-12-29', '2011-12-29T10:00:00.000Z', '2011-12-30T10:00:00.000Z'],
  ];
  for (const [timeZone, instant, day, periodStart, periodEnd] of cases) {
    const expected = { timeZone: timeZone!, day: day!, calendar: 'iso8601' as const,
      periodStart: periodStart!, periodEnd: periodEnd! };
    expect(ratingDayPeriod(timeZone!, instant!)).toEqual(expected);
    expect(retainedRatingPeriod(expected)).toEqual(expected);
  }
  for (const invalid of ['-05:00', '+0100', 'GMT-5', 'Unknown/Zone', ' UTC ']) {
    expect(() => canonicalRatingTimeZone(invalid)).toThrow();
  }
});

test('RATE03: daily slots count the private principal and civil day independently of personas', () => {
  const principal = '00000000-0000-4000-8000-000000000001';
  const context = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const main = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
  const first = dailyRatingSlotIri(principal, context, main, '2026-03-08');
  expect(first).not.toContain(principal);
  expect(first).not.toBe(dailyRatingSlotIri(principal, context, main, '2026-03-09'));
  expect(first).not.toBe(dailyRatingSlotIri('00000000-0000-4000-8000-000000000004', context, main, '2026-03-08'));
});
