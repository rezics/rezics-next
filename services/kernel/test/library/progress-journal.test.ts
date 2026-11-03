import { expect, test } from 'bun:test';
import {
  MAX_JOURNAL_REFLECTION_BYTES,
  MAX_JOURNAL_REFLECTION_CHARACTERS,
  parseProgressSessionJournalPatch,
} from '../../src/library/progress-journal.ts';

test('journal patches preserve omitted, cleared and partial date fields', () => {
  expect(parseProgressSessionJournalPatch({ revision: 0 })).toEqual({ ok: true, value: { revision: 0 } });
  expect(
    parseProgressSessionJournalPatch({
      revision: 4,
      startDate: { year: 2024, month: 2 },
      finishDate: null,
      reflection: null,
    }),
  ).toEqual({
    ok: true,
    value: { revision: 4, startDate: { year: 2024, month: 2 }, finishDate: null, reflection: null },
  });
});

test('journal patches reject invented date shapes and over-bound reflections', () => {
  expect(parseProgressSessionJournalPatch({ revision: 0, startDate: { year: 2024, day: 2 } })).toEqual({
    ok: false,
    field: 'startDate',
  });
  expect(parseProgressSessionJournalPatch({ revision: 0, finishDate: { year: 2023, month: 2, day: 29 } })).toEqual({
    ok: false,
    field: 'finishDate',
  });
  expect(
    parseProgressSessionJournalPatch({ revision: 0, reflection: 'x'.repeat(MAX_JOURNAL_REFLECTION_CHARACTERS + 1) }),
  ).toEqual({ ok: false, field: 'reflection' });
  const overBytes = '😀'.repeat(Math.floor(MAX_JOURNAL_REFLECTION_BYTES / 4) + 1);
  expect(Array.from(overBytes)).toHaveLength(1_025);
  expect(parseProgressSessionJournalPatch({ revision: 0, reflection: overBytes })).toEqual({
    ok: false,
    field: 'reflection',
  });
});
