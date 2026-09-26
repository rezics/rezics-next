import { expect, test } from 'bun:test';
import { eventEndpointBounds, checkedDateRange, checkedInstantRange,
  UnsupportedEventTime } from '../src/modules/event/time.ts';
import { eventTimeSlotIri } from '../src/modules/event/observation.ts';
import { EVENT_QUERY_COST_CONTRACT } from '../src/modules/event/queries.ts';

const temporal = (lexical: string, precision: 'year' | 'month' | 'day' | 'minute' | 'second') => ({
  state: 'known' as const,
  value: { kind: 'temporal' as const, lexical, precision, calendar: 'gregorian' as const },
});

test('RATE07: month precision overlaps a day as possible but has no definite day', () => {
  const may = eventEndpointBounds(temporal('2026-05', 'month'), 'civil-date');
  const queriedDay = { start: '2026-05-15', end: '2026-05-15' };
  expect(may).toMatchObject({ civilMin: '2026-05-01', civilMax: '2026-05-31' });
  expect(may.civilMin! <= queriedDay.end && may.civilMax! >= queriedDay.start).toBe(true);
  expect(may.civilMin === queriedDay.start && may.civilMax === queriedDay.end).toBe(false);
});

test('RATE08: actual and planned time slots share event identity without sharing slot identity', () => {
  const event = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  expect(eventTimeSlotIri(event, 'actual')).toBe(eventTimeSlotIri(event, 'actual'));
  expect(eventTimeSlotIri(event, 'actual')).not.toBe(eventTimeSlotIri(event, 'planned'));
});

test('RATE09: open bounds remain absent and unsupported instant comparison stays explicit', () => {
  const open = eventEndpointBounds({ state: 'open', lexical: 'no known end' }, 'civil-date');
  expect(open).toMatchObject({ state: 'open', civilMin: null, civilMax: null });
  expect(checkedDateRange('2026-05', '2026-05', 'month').buckets).toBe(1);
  expect(checkedInstantRange('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z').end)
    .toBe('2026-05-02T00:00:00Z');
  expect(() => eventEndpointBounds(temporal('2026-05', 'month'), 'instant'))
    .toThrow(UnsupportedEventTime);
});

test('RATE07/RATE08/RATE09: Event query limits bound source, page, aliases and histogram fanout', () => {
  expect(EVENT_QUERY_COST_CONTRACT).toEqual({ maxEventTimeSlots: 2000, maxPageSize: 50,
    maxTopicStatements: 8, maxHistogramBuckets: 732, maxSourceBindings: 2001 });
  expect(checkedDateRange('2026-01-01', '2026-12-31', 'day').buckets * 2)
    .toBeLessThanOrEqual(EVENT_QUERY_COST_CONTRACT.maxHistogramBuckets);
});
