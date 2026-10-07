import { describe, expect, test } from 'bun:test';
import { formatDay } from '../format.ts';
import { dueInstant, dueIsOverdue } from './format.ts';

describe('due dates', () => {
  test('writes a calendar day and shows it in the shared fixed zone, with no clock', () => {
    const written = dueInstant('2026-10-05');
    expect(written).toBe('2026-10-05T23:59:59.999Z');
    expect(formatDay(written!, 'en')).toBe('Oct 5, 2026');
    expect(formatDay('2026-10-05T22:41:00.000Z', 'en')).toBe('Oct 5, 2026');
  });

  test('a due day is overdue only after that date, not when its clock has passed', () => {
    const during = Date.parse('2026-10-05T22:41:00.000Z');
    expect(dueIsOverdue('2026-10-05T00:00:00.000Z', during)).toBe(false);
    expect(dueIsOverdue('2026-10-05T22:41:00.000Z', during)).toBe(false);
    expect(dueIsOverdue(dueInstant('2026-10-05')!, during)).toBe(false);
    const next = Date.parse('2026-10-06T00:00:00.000Z');
    expect(dueIsOverdue('2026-10-05T23:59:59.999Z', next)).toBe(true);
    expect(dueIsOverdue('2026-10-06T00:00:00.000Z', next)).toBe(false);
  });
});
