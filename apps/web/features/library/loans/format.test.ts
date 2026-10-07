import { describe, expect, test } from 'bun:test';
import { formatDue } from './format.ts';

describe('due dates', () => {
  test('prints a real time in the viewer zone and locale, without a UTC label', () => {
    const shown = formatDue('2026-10-05T22:41:00.000Z', 'en', 'America/Los_Angeles');
    expect(shown).toBe('Oct 5, 2026, 3:41 PM');
    expect(shown).not.toContain('UTC');
  });

  test('prints only the day when the clock in that zone is midnight', () => {
    expect(formatDue('2026-10-05T00:00:00.000Z', 'en', 'UTC')).toBe('Oct 5, 2026');
  });
});
