import { expect, test } from 'bun:test';
import {
  beginPublication,
  editPublication,
  publicationDraft,
  settlePublication,
} from '../src/library/logs-publication';

test('uncertain publication preserves the explicit public note and original identity until resolved', () => {
  const draft = publicationDraft('chosen-session');
  const credential = { 'x-csrf-token': 'original' };
  editPublication(draft, '  My public milestone  ');
  const first = beginPublication(draft, credential)!;
  expect(first.intent).toEqual({
    sessionId: 'chosen-session',
    note: 'My public milestone',
    idempotencyKey: expect.any(String),
  });
  expect(beginPublication(draft, { 'x-csrf-token': 'rotated' })).toBeUndefined();
  editPublication(draft, 'Private later input');
  expect(draft.note).toBe('  My public milestone  ');
  settlePublication(draft, first, { ok: false, reason: 'unavailable' });
  editPublication(draft, 'Private later input');
  expect(draft.note).toBe('  My public milestone  ');
  const retry = beginPublication(draft, { 'x-csrf-token': 'rotated' })!;
  expect(retry.intent).toBe(first.intent);
  expect(retry.credential).toBe(credential);
  settlePublication(draft, first, { ok: true, id: 'late-duplicate' });
  expect(draft.flight).toBe(retry);
  settlePublication(draft, retry, { ok: true, id: 'published-log' });
  expect(draft.publishedId).toBe('published-log');
  expect(draft.note).toBe('');
  expect(draft.intent).toBeUndefined();
  expect(draft.credential).toBeUndefined();
  expect(draft.flight).toBeUndefined();
  expect(draft.failure).toBeUndefined();
  editPublication(draft, 'Another choice');
  expect(draft.note).toBe('');
  expect(beginPublication(draft, credential)).toBeUndefined();
});

test('a definite refusal keeps private input editable and retires the refused identity', () => {
  for (const reason of ['closed', 'conflict', 'forbidden', 'invalid'] as const) {
    const draft = publicationDraft('session');
    editPublication(draft, 'Not accepted yet');
    const first = beginPublication(draft, { 'x-csrf-token': 'original' })!;
    settlePublication(draft, first, { ok: false, reason });
    expect(draft.note).toBe('Not accepted yet');
    expect(draft.failure).toBe(reason);
    expect(draft.intent).toBeUndefined();
    expect(draft.credential).toBeUndefined();
    editPublication(draft, 'Corrected public note');
    const corrected = beginPublication(draft, { 'x-csrf-token': 'current' })!;
    expect(corrected.intent.note).toBe('Corrected public note');
    expect(corrected.intent.idempotencyKey).not.toBe(first.intent.idempotencyKey);
  }
});

test('an explicit blank publication never imports private session notes or progress facts', () => {
  const draft = publicationDraft('session');
  editPublication(draft, ' \n ');
  const attempt = beginPublication(draft, { 'x-csrf-token': 'current' })!;
  expect(Object.keys(attempt.intent).sort()).toEqual(['idempotencyKey', 'sessionId']);
  const replacement = publicationDraft('another-session');
  settlePublication(draft, attempt, { ok: true, id: 'old-log' });
  expect(replacement.note).toBe('');
  expect(replacement.publishedId).toBeUndefined();
});
