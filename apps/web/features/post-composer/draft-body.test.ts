import { expect, test } from 'bun:test';
import { fromPlainText, normalizeDocument, parseStoredDocument, serializeDocument, withDocumentIds } from '@rezics/document';
import { documentPublication } from '../document-editor/publication.ts';
import { persistDraftBody } from './draft-body.ts';

test('recovery is cleared only after the current complete body is stored, and a failed device write can retry without losing content', async () => {
  const current = normalizeDocument({ ...fromPlainText('Retained current text.', 'blocks'), doc: withDocumentIds({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Retained current text.', marks: [{ type: 'bold' }] }] },
    { type: 'image', attrs: { id: '22222222-2222-4222-8222-222222222222', src: '/image.png',
      representationId: '11111111-1111-4111-8111-111111111111', mediaUseId: '33333333-3333-4333-8333-333333333333' } },
  ] }) });
  const raw = JSON.stringify({ ...current, doc: { ...current.doc, content: [...current.doc.content!,
    { type: 'image', attrs: { src: '/invalid-image.png', representationId: 'invalid' } }] } });
  let draft = { title: 'Keep this title', body: serializeDocument(fromPlainText('Older saved text', 'blocks')), recoveryBody: raw as string | undefined };
  let stored = JSON.stringify(draft), unavailable = true;
  const states: string[] = [];
  const publication = documentPublication(async next => next, body => {
    draft = persistDraftBody(draft, body, next => {
      // Before the write is acknowledged, the owner must still retain recovery.
      expect(draft.recoveryBody).toContain('Retained current text.');
      if (unavailable) throw new Error('Device full');
      stored = JSON.stringify(next);
    });
  }, (state, _error, retained) => {
    states.push(state);
    if (retained) draft = { ...draft, recoveryBody: JSON.stringify(retained) };
  });
  expect(await publication.publish(current)).toBe(false);
  expect(states.at(-1)).toBe('failed');
  expect(draft.body).toContain('Older saved text');
  expect(draft.recoveryBody).toContain('Retained current text.');
  expect(JSON.parse(stored).recoveryBody).toBe(raw);

  unavailable = false;
  expect(await publication.retry()).toBe(true);
  expect(states.at(-1)).toBe('ready');
  const reopened = JSON.parse(stored);
  expect(reopened.title).toBe('Keep this title');
  expect(reopened.recoveryBody).toBeUndefined();
  expect(parseStoredDocument(reopened.body)).toEqual(current);
  expect(draft.recoveryBody).toBeUndefined();
});
