import { expect, test } from 'bun:test';
import { adoptCopyConflictDraft } from '../src/library/copy-conflict-review';
import type { CopyDraft } from '../src/library/copy-fields';
import type { CopyItem } from '../src/library/copies-read';

const draft = (note: string, location = 'Study'): CopyDraft => ({
  status: 'owned',
  location,
  source: 'Shop',
  acquiredOn: '2020-02-29',
  disposedOn: '',
  note,
});

const copy = (note: string, revision = 9): CopyItem => ({
  id: 'copy-1',
  status: 'owned',
  kind: 'print',
  revision,
  location: 'Shelf',
  source: 'Shop',
  acquiredOn: '2020-02-29',
  disposedOn: null,
  note,
  subject: null,
  idempotencyKey: 'key',
});

test('conflict review keeps local field edits and adopts newly read values for untouched fields', () => {
  const baseline = { draft: draft('Original note'), kind: 'print' };
  const local = { draft: draft('My draft'), kind: 'print' };
  const adopted = adoptCopyConflictDraft(baseline, local, copy('Current note', 10));
  expect(adopted.draft.note).toBe('My draft');
  expect(adopted.draft.location).toBe('Shelf');
  expect(adopted.copy.revision).toBe(10);
  expect(adopted.copy.note).toBe('My draft');
  expect(adopted.copy.location).toBe('Shelf');
  expect(adopted.kind).toBe('print');
});

test('untouched drafts take every newly read field including a blank stored value', () => {
  const baseline = { draft: draft('Original note', 'Study'), kind: 'print' };
  const adopted = adoptCopyConflictDraft(baseline, baseline, { ...copy('Current note'), location: null });
  expect(adopted.draft).toEqual({
    status: 'owned',
    location: '',
    source: 'Shop',
    acquiredOn: '2020-02-29',
    disposedOn: '',
    note: 'Current note',
  });
  expect(adopted.copy.location).toBeNull();
});
