import { expect, test } from 'bun:test';
import type { ShelfSelectionCandidate } from '../src/library/shelf-selection';
import { captureBulkStatusPreview } from '../src/library/bulk-status';

const id = (value: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(value).padStart(12, '0')}`;
const completed = { id: 'completed', label: { text: 'Completed', lang: 'en' } };
const entry = (value: number, stateOptions = [completed]): ShelfSelectionCandidate & { state: string } => ({
  subjectId: id(value),
  subject: { id: id(value) },
  stateOptions,
  state: 'reading',
});

test('previews the selected loaded canonical subjects in order without changing their status', () => {
  const loaded = [entry(1), entry(2), entry(3)];
  const captured = captureBulkStatusPreview([loaded[1]!, loaded[0]!, loaded[1]!], 'completed');

  expect(captured).toMatchObject({
    ok: true,
    request: {
      action: 'set_status',
      state: 'completed',
      selection: {
        kind: 'explicit',
        targets: [{ subjectId: id(2) }, { subjectId: id(1) }],
      },
    },
  });
  expect(loaded.map(({ state }) => state)).toEqual(['reading', 'reading', 'reading']);
});

test('refuses an unsupported selected target or an oversized target set instead of omitting either', () => {
  expect(captureBulkStatusPreview([entry(1), entry(2, [])], 'completed')).toMatchObject({
    ok: false,
    reason: 'unsupported_selection',
  });
  expect(
    captureBulkStatusPreview(
      Array.from({ length: 1001 }, (_, index) => entry(index + 1)),
      'completed',
    ),
  ).toMatchObject({
    ok: false,
    reason: 'too_many_targets',
  });
});
