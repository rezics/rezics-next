import { describe, expect, test } from 'bun:test';
import { formatDay } from '../format.ts';
import { dueInstant } from './format.ts';

describe('due dates', () => {
  test('writes a calendar day and shows it in the shared fixed zone, with no clock', () => {
    const written = dueInstant('2026-10-05');
    expect(written).toBe('2026-10-05T23:59:59.999Z');
    expect(formatDay(written!, 'en')).toBe('Oct 5, 2026');
    expect(formatDay('2026-10-05T22:41:00.000Z', 'en')).toBe('Oct 5, 2026');
  });
});
