import { expect, test } from 'bun:test';
import type { PersonalEntry } from '@rezics/client';
import { annotationWrite } from '../src/library/rich-private-entry/contract';

const entry: PersonalEntry = {
  subjectId: 'subject-1',
  annotationRevision: 4,
  note: 'private note',
  priority: 7,
  annotationUpdatedAt: '2026-01-01T00:00:00Z',
  sourceObservations: [],
};

test('private annotation edits clear only the field the owner changed', () => {
  expect(annotationWrite(entry, { note: 'revised note', priority: '7' })).toEqual({
    revision: 4,
    note: { op: 'set', value: 'revised note' },
    priority: { op: 'unchanged' },
  });
  expect(annotationWrite(entry, { note: 'private note', priority: '' })).toEqual({
    revision: 4,
    note: { op: 'unchanged' },
    priority: { op: 'clear' },
  });
});

test('private annotation bounds use UTF-8 bytes and unchanged edits send no command', () => {
  expect(annotationWrite({ ...entry, note: null, priority: null }, { note: '', priority: '' })).toBeNull();
  expect(annotationWrite({ ...entry, note: null }, { note: 'é'.repeat(2048), priority: '7' })?.note).toEqual({
    op: 'set',
    value: 'é'.repeat(2048),
  });
  expect(annotationWrite(entry, { note: 'é'.repeat(2049), priority: '7' })).toBeNull();
  expect(annotationWrite(entry, { note: entry.note!, priority: '101' })).toBeNull();
});
